--[[
simple_voicechat: server-side half of Simple Voice Chat for Luanti.

Why this is not a normal mod
---------------------------
Luanti's Lua API runs on the game server only, has no microphone capture and no
raw sockets. Audio therefore cannot live inside a Luanti mod. This mod owns
everything the *game* knows: who is online, where they are and where they look,
who opted out, and who may moderate.A companion relay turns that state into proximity voice routing. The native
client fork in client/ supplies microphone capture, Opus, UDP and OpenAL
playback; the browser panel remains the fallback.

The public API for other mods is the global `simple_voicechat` table at the
bottom of this file. Wire protocol: docs/PROTOCOL.md
]]

local modname = core.get_current_modname()
local translator = core.get_translator and core.get_translator(modname)

-- `core.get_translator` is only available in newer Luanti releases, so the
-- fallback must still expand the "@1" placeholders the call sites use.
local function S(str, ...)
	local text = translator and translator(str) or str
	if select("#", ...) == 0 then return text end
	local args = { ... }
	return (text:gsub("@(%d+)", function(index)
		local value = args[tonumber(index)]
		if value == nil then return "@" .. index end
		return tostring(value)
	end))
end

local function setting_bool(name, default)
	local value = core.settings:get_bool(name)
	if value == nil then return default end
	return value
end

local relay_url = (core.settings:get("simple_voicechat.relay_url") or ""):gsub("/+$", "")
local secret = core.settings:get("simple_voicechat.secret") or ""
local sync_interval = tonumber(core.settings:get("simple_voicechat.sync_interval")) or 0.25
local show_hud = setting_bool("simple_voicechat.hud", true)
local join_hint = setting_bool("simple_voicechat.join_hint", true)
local force_voice = setting_bool("simple_voicechat.force_voice_chat", false)
local nametag_indicators = setting_bool("simple_voicechat.nametag_indicators", true)

if sync_interval < 0.1 then sync_interval = 0.1 elseif sync_interval > 2.0 then sync_interval = 2.0 end

-- Must be requested from the mod's init.lua, not from a function.
-- Requires `secure.http_mods = simple_voicechat` in minetest.conf.
local http = core.request_http_api and core.request_http_api()
local configured = http ~= nil and relay_url ~= "" and secret ~= ""

local FORMNAME = "simple_voicechat:panel"
local SPEAKING_COLOR = "#7CFF9B"
local DEFAULT_NAMETAG_COLOR = "#FFFFFF"

local state = {
	online = false,
	error = nil,
	players = {}, -- name -> {connected, group, admin_muted, speaking, broadcasting}
	max_voice_distance = nil,
	whisper_distance = nil,
	broadcast_range = 0,
	allow_recording = false,
	links = {}, -- name -> {url, code, expires}
	sync_handle = nil,
	sync_accum = 0,
	code_requests = {}, -- name -> true
	pending = {}, -- {handle, callback}
	hud = {}, -- name -> hud id
	hud_text = {}, -- name -> last drawn text
	nametags = {}, -- name -> original colour while the speaking tint is applied
}

local api = { version = 1 }
simple_voicechat = api
local listeners = {}

local function round2(value)
	return math.floor(value * 100 + 0.5) / 100
end

local function is_disabled(player)
	return player:get_meta():get_int("simple_voicechat_disabled") == 1
end

local function set_disabled(player, disabled)
	player:get_meta():set_int("simple_voicechat_disabled", disabled and 1 or 0)
end

local function describe_error(res)
	if res.timeout then return S("relay timed out") end
	if res.succeeded then return nil end
	local code = tonumber(res.code) or 0
	if code == 0 then return S("relay unreachable") end
	if code == 401 then return S("relay rejected the shared secret") end
	if code == 409 then return S("player not known to the relay") end
	return S("relay error (HTTP @1)", tostring(code))
end

local function decode(res)
	if type(res.data) ~= "string" then return nil end
	local ok, data = pcall(core.parse_json, res.data)
	if ok and type(data) == "table" then return data end
	return nil
end

-- ------------------------------------------------------------------- HTTP

local function post(path, body, callback)
	if not http then
		if callback then callback({ completed = true, succeeded = false, code = 0 }) end
		return
	end
	local handle = http.fetch_async({
		url = relay_url .. path,
		method = "POST",
		timeout = 5,
		extra_headers = {
			"Content-Type: application/json; charset=utf-8",
			"Accept: application/json",
			"Authorization: Bearer " .. secret,
		},
		data = core.write_json(body),
	})
	if not handle then
		if callback then callback({ completed = true, succeeded = false, code = 0 }) end
		return
	end
	state.pending[#state.pending + 1] = { handle = handle, callback = callback }
end

-- Results are read from the main thread in the globalstep below rather than in
-- a completion callback, so every core.* call happens on the server thread.
local function poll_pending()
	for index = #state.pending, 1, -1 do
		local entry = state.pending[index]
		local res = http.fetch_async_get(entry.handle)
		if res and res.completed then
			table.remove(state.pending, index)
			if entry.callback then
				local ok, err = pcall(entry.callback, res)
				if not ok then
					core.log("error", "[simple_voicechat] request callback failed: " .. tostring(err))
				end
			end
		end
	end
end

-- -------------------------------------------------------------- indicators

local function hud_text_for(name)
	local info = state.players[name]
	if info and info.connected then
		if info.admin_muted then return "VOICE  muted by admin" end
		local parts = { "VOICE" }
		if info.broadcasting then
			parts[#parts + 1] = "broadcasting"
		elseif info.group then
			parts[#parts + 1] = "group " .. info.group
		end
		if info.speaking then parts[#parts + 1] = "talking" end
		return table.concat(parts, "  ")
	end
	if force_voice and configured and state.online then
		return "VOICE required  /voice"
	end
	return nil
end

local function update_hud(player)
	local name = player:get_player_name()
	local text = show_hud and hud_text_for(name) or nil

	if text == state.hud_text[name] then return end

	local hud_id = state.hud[name]
	if not text then
		if hud_id then
			player:hud_remove(hud_id)
			state.hud[name] = nil
		end
		state.hud_text[name] = nil
		return
	end

	local info = state.players[name]
	local color = info and info.speaking and 0x7CFF9B or 0x7FD1FF
	if hud_id then
		if state.hud_text[name] ~= nil and state.hud_text[name]:find("talking", 1, true) ~= text:find("talking", 1, true) then
			player:hud_change(hud_id, "number", color)
		end
		player:hud_change(hud_id, "text", text)
	else
		state.hud[name] = player:hud_add({
			hud_elem_type = "text",
			position = { x = 1, y = 0 },
			offset = { x = -16, y = 10 },
			alignment = { x = -1, y = 1 },
			number = color,
			text = text,
		})
	end
	state.hud_text[name] = text
end

local function update_nametag(player, speaking)
	if not nametag_indicators then return end
	local name = player:get_player_name()

	if speaking then
		if state.nametags[name] ~= nil then return end
		local ok, attrs = pcall(player.get_nametag_attributes, player)
		local original = ok and attrs and attrs.color or nil
		if type(original) ~= "string" and type(original) ~= "table" then
			original = DEFAULT_NAMETAG_COLOR
		end
		state.nametags[name] = original
		player:set_nametag_attributes({ color = SPEAKING_COLOR })
	elseif state.nametags[name] ~= nil then
		player:set_nametag_attributes({ color = state.nametags[name] })
		state.nametags[name] = nil
	end
end

local function update_indicators()
	for _, player in ipairs(core.get_connected_players()) do
		update_hud(player)
		local info = state.players[player:get_player_name()]
		update_nametag(player, info and info.connected and info.speaking or false)
	end
end

-- -------------------------------------------------------------- state sync

local function collect_players()
	local list = {}
	for _, player in ipairs(core.get_connected_players()) do
		local pos = player:get_pos()
		if pos then
			local yaw = 0
			if player.get_look_horizontal then
				local ok, value = pcall(player.get_look_horizontal, player)
				if ok and type(value) == "number" then yaw = value end
			end
			list[#list + 1] = {
				name = player:get_player_name(),
				pos = { round2(pos.x), round2(pos.y), round2(pos.z) },
				yaw = yaw,
				voice = not is_disabled(player),
			}
		end
	end
	return list
end

local function start_sync()
	if not configured then return end
	state.sync_handle = http.fetch_async({
		url = relay_url .. "/api/v1/sync",
		method = "POST",
		timeout = 5,
		extra_headers = {
			"Content-Type: application/json; charset=utf-8",
			"Authorization: Bearer " .. secret,
		},
		data = core.write_json({ players = collect_players() }),
	})
end

local function notify(name, info)
	for _, callback in ipairs(listeners) do
		local ok, err = pcall(callback, name, info)
		if not ok then
			core.log("error", "[simple_voicechat] status listener failed: " .. tostring(err))
		end
	end
end

local function apply_status(data)
	local previous = state.players
	state.online = true
	state.error = nil
	state.players = data.players or {}
	state.max_voice_distance = data.max_voice_distance or state.max_voice_distance
	state.whisper_distance = data.whisper_distance or state.whisper_distance
	state.broadcast_range = data.broadcast_range or state.broadcast_range
	state.allow_recording = data.allow_recording == true

	for name, info in pairs(state.players) do
		local old = previous[name]
		if
			not old
			or old.connected ~= info.connected
			or old.group ~= info.group
			or old.speaking ~= info.speaking
			or old.admin_muted ~= info.admin_muted
			or old.broadcasting ~= info.broadcasting
		then
			notify(name, info)
		end
	end
	for name in pairs(previous) do
		if not state.players[name] then notify(name, nil) end
	end

	update_indicators()
end

local function handle_sync_result(res)
	if res.succeeded and res.code == 200 then
		local data = decode(res)
		if data then
			apply_status(data)
			return
		end
		state.online = false
		state.error = S("invalid response from the relay")
		update_indicators()
		return
	end
	state.online = false
	state.error = describe_error(res) or S("relay error")
	update_indicators()
end

-- ------------------------------------------------------------------ codes

local show_panel

local function valid_link(name)
	local link = state.links[name]
	if not link then return nil end
	if link.expires and link.expires > 0 and link.issued and os.time() - link.issued >= link.expires then
		state.links[name] = nil
		return nil
	end
	return link
end

local function request_code(name, opts)
	if not configured then
		if not http then
			core.chat_send_player(name, S('Voice chat is not set up: add "simple_voicechat" to secure.http_mods in minetest.conf.'))
		else
			core.chat_send_player(name, S("Voice chat is not set up: set simple_voicechat.relay_url and simple_voicechat.secret in minetest.conf."))
		end
		return false
	end
	if state.code_requests[name] then return false end
	state.code_requests[name] = true

	post("/api/v1/token", { player = name }, function(res)
		state.code_requests[name] = nil
		if not (res.succeeded and res.code == 200) then
			core.chat_send_player(name, S("Voice chat: could not get a link: @1", describe_error(res) or S("unknown error")))
			return
		end
		local data = decode(res)
		if not data or type(data.code) ~= "string" then
			core.chat_send_player(name, S("Voice chat: the relay sent an unexpected response."))
			return
		end
		state.links[name] = {
			url = data.url,
			code = data.code,
			expires = tonumber(data.expires_in) or 0,
			issued = os.time(),
		}
		core.chat_send_player(
			name,
			S("Voice chat: open @1 and enter code @2 (valid for @3 s).", tostring(data.url), data.code, tostring(data.expires_in or "?"))
		)
		-- Native client hook: the patched Luanti client consumes this private
		-- line and joins the UDP relay without copying the code by hand.
		core.chat_send_player(name, "SVC-TOKEN:" .. data.code)
		if opts and opts.refresh and core.get_player_by_name(name) then
			show_panel(name)
		end
	end)
	return true
end

-- --------------------------------------------------------------------- UI

local function status_text()
	if not http then
		return S("Not configured: the HTTP API is disabled.")
	elseif relay_url == "" or secret == "" then
		return S("Not configured: missing relay URL or secret.")
	elseif state.error then
		return S("Relay: @1", state.error)
	elseif state.online then
		return S(
			"Relay: connected. Range @1 nodes, whisper @2, broadcast @3.",
			tostring(state.max_voice_distance or "?"),
			tostring(state.whisper_distance or "?"),
			state.broadcast_range > 0 and tostring(state.broadcast_range) or S("off")
		)
	end
	return S("Relay: waiting for the first update...")
end

function show_panel(name)
	local player = core.get_player_by_name(name)
	if not player then return end
	local link = valid_link(name)

	local names = {}
	for other, info in pairs(state.players) do
		if info.connected then
			local label = info.group and (other .. " [" .. info.group .. "]") or other
			if info.broadcasting then label = label .. " (broadcast)" end
			names[#names + 1] = label
		end
	end
	table.sort(names)
	local on_voice = #names > 0 and table.concat(names, ", ") or S("nobody yet")
	if #on_voice > 110 then on_voice = on_voice:sub(1, 107) .. "..." end

	local toggle_label = is_disabled(player) and S("Enable my voice") or S("Disable my voice")
	local code = link and link.code or ""
	local url = link and link.url or relay_url

	local formspec = table.concat({
		"formspec_version[4]",
		"size[10,6.7]",
		"box[0,0;10,6.7;#101319]",
		"box[0.3,0.3;9.4,0.8;#1b2233]",
		"label[0.5,0.72;Simple Voice Chat]",
		"label[0.5,1.32;" .. core.formspec_escape(status_text()) .. "]",
		"label[0.5,1.85;Open the voice panel in your browser and enter this code:]",
		"field[0.5,2.15;2.4,0.85;code;Code;" .. core.formspec_escape(code) .. "]",
		"button[3.1,2.2;2.6,0.7;refresh;New code]",
		"button[5.9,2.2;3.6,0.7;print;Print link to chat]",
		"label[0.5,3.3;Panel URL:]",
		"field[0.5,3.55;9.0,0.8;url;;" .. core.formspec_escape(url) .. "]",
		"label[0.5,4.65;On voice: " .. core.formspec_escape(on_voice) .. "]",
		"button[0.5,5.9;2.6,0.6;toggle;" .. core.formspec_escape(toggle_label) .. "]",
		"button_exit[6.9,5.9;2.6,0.6;close;Close]",
	}, "")
	core.show_formspec(name, FORMNAME, formspec)
end

local function print_link(name)
	local link = valid_link(name)
	if not link then
		core.chat_send_player(name, S("Voice chat: request a code first with /voice."))
		return
	end
	core.chat_send_player(name, S("Voice panel: @1 - code @2", tostring(link.url), link.code))
end

local function admin_request(actor, path, body, ok_message)
	post(path, body, function(res)
		if res.succeeded and res.code == 200 then
			if ok_message then core.chat_send_player(actor, ok_message) end
			return
		end
		if res.code == 404 then
			core.chat_send_player(actor, S("Voice chat: player not found on voice chat."))
			return
		end
		core.chat_send_player(actor, S("Voice chat: request failed: @1", describe_error(res) or S("unknown error")))
	end)
end

local function status_command(name)
	local connected = 0
	local groups = {}
	for other, info in pairs(state.players) do
		if info.connected then
			connected = connected + 1
			if info.group then groups[info.group] = true end
		end
	end
	local group_names = {}
	for group in pairs(groups) do group_names[#group_names + 1] = group end
	table.sort(group_names)

	core.chat_send_player(
		name,
		S("Voice chat: @1 of @2 players on voice. Relay: @3", tostring(connected), tostring(#core.get_connected_players()), status_text())
	)
	if #group_names > 0 then
		core.chat_send_player(name, S("Groups: @1", table.concat(group_names, ", ")))
	end
end

local function list_groups(actor)
	post("/api/v1/admin/groups", {}, function(res)
		if not (res.succeeded and res.code == 200) then
			core.chat_send_player(actor, S("Voice chat: could not list groups: @1", describe_error(res) or S("unknown error")))
			return
		end
		local data = decode(res)
		local groups = data and data.groups or {}
		if #groups == 0 then
			core.chat_send_player(actor, S("Voice chat: no groups are open."))
			return
		end
		for _, group in ipairs(groups) do
			core.chat_send_player(
				actor,
				S("@1 (@2): @3 (locked: @4)", tostring(group.name), tostring(group.type or "normal"), table.concat(group.members or {}, ", "), group.locked and S("yes") or S("no"))
			)
		end
	end)
end

-- ---------------------------------------------------------------- commands

core.register_privilege("voice_admin", {
	description = S("Mute or kick players from voice chat"),
	give_to_singleplayer = false,
})

core.register_chatcommand("voice", {
	description = S("Open the voice chat panel"),
	params = "[code | status | invite <player> | disable | enable | admin <mute|unmute|kick|groups> [player]]",
	func = function(name, param)
		local argv = {}
		for word in param:gmatch("%S+") do argv[#argv + 1] = word end
		local sub = (argv[1] or ""):lower()

		if sub == "" then
			show_panel(name)
			if not valid_link(name) then request_code(name, { refresh = true }) end
			return true
		end

		if sub == "code" or sub == "link" then
			request_code(name, { refresh = true })
			return true
		end

		if sub == "status" then
			status_command(name)
			return true
		end

		if sub == "invite" then
			local target = argv[2]
			if not target then
				return false, S("Usage: /voice invite <player>")
			end
			if not (state.players[name] and state.players[name].connected) then
				return false, S("Join voice chat first, then invite players to your group.")
			end
			post("/api/v1/admin/invite", { from = name, player = target }, function(res)
				if res.succeeded and res.code == 200 then
					core.chat_send_player(name, S("Voice chat: invited @1 to your group.", target))
					return
				end
				local data = decode(res)
				if data and type(data.error) == "string" then
					core.chat_send_player(name, S("Voice chat: @1", data.error))
					return
				end
				core.chat_send_player(name, S("Voice chat: request failed: @1", describe_error(res) or S("unknown error")))
			end)
			return true
		end

		if sub == "disable" or sub == "enable" then
			local player = core.get_player_by_name(name)
			if not player then return false, S("Player not found.") end
			set_disabled(player, sub == "disable")
			state.links[name] = nil
			core.chat_send_player(name, sub == "disable"
				and S("Voice chat disabled. Use /voice enable to turn it back on.")
				or S("Voice chat enabled. Use /voice for a new code."))
			if not state.sync_handle then start_sync() end
			return true
		end

		if sub == "admin" then
			if not core.check_player_privs(name, { voice_admin = true }) then
				return false, S("You need the voice_admin privilege.")
			end
			local action = (argv[2] or ""):lower()
			local target = argv[3]

			if action == "groups" then
				list_groups(name)
				return true
			end
			if (action == "mute" or action == "unmute") and target then
				admin_request(
					name,
					"/api/v1/admin/mute",
					{ player = target, muted = action == "mute" },
					S("Voice chat: @1 @2.", action, target)
				)
				return true
			end
			if action == "kick" and target then
				admin_request(name, "/api/v1/admin/kick", { player = target }, S("Voice chat: kicked @1.", target))
				return true
			end
			return false, S("Usage: /voice admin <mute|unmute|kick> <player> | /voice admin groups")
		end

		return false, S("Usage: /voice [code | status | invite <player> | disable | enable | admin ...]")
	end,
})

-- ------------------------------------------------------------------ hooks

core.register_on_joinplayer(function(player)
	local name = player:get_player_name()
	state.links[name] = nil
	if not (join_hint and configured) then return end
	core.after(2, function()
		if core.get_player_by_name(name) then
			core.chat_send_player(name, S("Voice chat is available: type /voice to get a join code."))
		end
	end)
end)

core.register_on_leaveplayer(function(player)
	local name = player:get_player_name()
	state.links[name] = nil
	state.players[name] = nil
	state.hud[name] = nil
	state.hud_text[name] = nil
	state.nametags[name] = nil
end)

core.register_on_player_receive_fields(function(player, formname, fields)
	if formname ~= FORMNAME then return end
	local name = player:get_player_name()

	if fields.refresh then
		request_code(name, { refresh = true })
		return true
	end
	if fields.print then
		print_link(name)
		return true
	end
	if fields.toggle then
		set_disabled(player, not is_disabled(player))
		state.links[name] = nil
		if not state.sync_handle then start_sync() end
		show_panel(name)
		return true
	end
	return true
end)

core.register_globalstep(function(dtime)
	if not configured then return end
	poll_pending()

	if state.sync_handle then
		local res = http.fetch_async_get(state.sync_handle)
		if res and res.completed then
			state.sync_handle = nil
			handle_sync_result(res)
		end
	end

	state.sync_accum = state.sync_accum + dtime
	if state.sync_handle or state.sync_accum < sync_interval then return end
	state.sync_accum = 0
	start_sync()
end)

-- --------------------------------------------------------------- public API

--- Status of one player, or nil when they are not in the game.
-- @return table {connected=bool, group=string|nil, admin_muted=bool, speaking=bool, broadcasting=bool}
function api.get_status(name)
	return state.players[name]
end

--- True when the player currently has a voice session on the relay.
function api.is_connected(name)
	local info = state.players[name]
	return info ~= nil and info.connected == true
end

--- Relay reachability and limits, as last reported by the relay.
function api.get_config()
	return {
		online = state.online,
		error = state.error,
		relay_url = relay_url,
		max_voice_distance = state.max_voice_distance,
		whisper_distance = state.whisper_distance,
		broadcast_range = state.broadcast_range,
		allow_recording = state.allow_recording,
	}
end

--- Last join code handed to a player (codes are short-lived and single use).
function api.get_join_code(name)
	local link = valid_link(name)
	return link and link.code or nil
end

--- Ask the relay for a fresh code and show the panel, if the player is online.
function api.request_code(name)
	return request_code(name, { refresh = true })
end

--- Called with (player_name, status_or_nil) whenever a player's voice state changes.
function api.register_on_status_change(callback)
	if type(callback) == "function" then
		listeners[#listeners + 1] = callback
	end
end

if not http then
	core.log("warning", '[simple_voicechat] HTTP API unavailable. Add "simple_voicechat" to secure.http_mods in minetest.conf.')
elseif relay_url == "" or secret == "" then
	core.log("warning", "[simple_voicechat] set simple_voicechat.relay_url and simple_voicechat.secret in minetest.conf.")
else
	core.log("action", "[simple_voicechat] relaying to " .. relay_url .. " every " .. tostring(sync_interval) .. "s")
end
