-- Minimal Luanti server API double for testing mods/simple_voicechat.
-- Deliberately strict: any core.* call the mod makes must exist here.

local M = {}

local function encode(value)
	local kind = type(value)
	if kind == "string" then
		return '"' .. value:gsub("\\", "\\\\"):gsub('"', '\\"') .. '"'
	elseif kind == "number" or kind == "boolean" then
		return tostring(value)
	elseif kind == "table" then
		if #value > 0 then
			local parts = {}
			for _, item in ipairs(value) do
				parts[#parts + 1] = encode(item)
			end
			return "[" .. table.concat(parts, ",") .. "]"
		end
		local parts = {}
		for key, item in pairs(value) do
			parts[#parts + 1] = encode(tostring(key)) .. ":" .. encode(item)
		end
		return "{" .. table.concat(parts, ",") .. "}"
	end
	return "null"
end

local function make_player(name, pos, yaw, meta)
	meta = meta or { ints = {} }
	local player = {
		_name = name,
		_pos = pos or { x = 0, y = 0, z = 0 },
		_yaw = yaw or 0,
		_meta = meta,
		_nametag = { color = "#FFFFFF" },
		_hud = {},
	}

	function player:get_player_name()
		return self._name
	end

	function player:get_pos()
		return { x = self._pos.x, y = self._pos.y, z = self._pos.z }
	end

	function player:get_look_horizontal()
		return self._yaw
	end

	function player:get_meta()
		local meta_obj = {}
		function meta_obj:get_int(key)
			return self.ints[key] or 0
		end
		function meta_obj:set_int(key, value)
			self.ints[key] = value
		end
		meta_obj.ints = self._meta.ints
		return meta_obj
	end

	function player:set_nametag_attributes(attributes)
		for key, value in pairs(attributes) do
			self._nametag[key] = value
		end
	end

	function player:get_nametag_attributes()
		local copy = {}
		for key, value in pairs(self._nametag) do
			copy[key] = value
		end
		return copy
	end

	function player:hud_add(definition)
		self._hud[#self._hud + 1] = definition
		return #self._hud
	end

	function player:hud_change(id, field, value)
		if self._hud[id] then
			self._hud[id][field] = value
		end
	end

	function player:hud_remove(id)
		self._hud[id] = nil
	end

	return player
end

function M.setup(options)
	options = options or {}

	local core = {}
	core.logs = {}
	core.chat = {}
	core.shown_formspecs = {}
	core.http_requests = {}
	core.http_results = {}
	core.parse_queue = {}
	core.players = {}
	core.players_list = {}
	core.privs = options.privs or {}
	core.callbacks = {
		joinplayer = {},
		leaveplayer = {},
		receive_fields = {},
		globalstep = {},
	}
	core.chatcommands = {}
	core.privileges = {}
	core.timers = {}

	core.settings = { values = options.settings or {} }
	function core.settings:get(key)
		return self.values[key]
	end
	function core.settings:get_bool(key)
		local value = self.values[key]
		if value == nil then
			return nil
		end
		return value
	end

	function core.get_current_modname()
		return "simple_voicechat"
	end

	function core.log(level, message)
		core.logs[#core.logs + 1] = { level = level, message = message }
	end

	function core.chat_send_player(name, message)
		core.chat[name] = core.chat[name] or {}
		core.chat[name][#core.chat[name] + 1] = message
	end

	function core.formspec_escape(value)
		return tostring(value):gsub("%[", "("):gsub("%]", ")"):gsub(";", ":")
	end

	function core.show_formspec(name, formname, formspec)
		core.shown_formspecs[#core.shown_formspecs + 1] = {
			name = name,
			formname = formname,
			formspec = formspec,
		}
	end

	function core.get_connected_players()
		return core.players_list
	end

	function core.get_player_by_name(name)
		return core.players[name]
	end

	function core.check_player_privs(name, privs)
		local granted = core.privs[name] or {}
		for priv in pairs(privs) do
			if not granted[priv] then
				return false
			end
		end
		return true
	end

	function core.register_privilege(name, definition)
		core.privileges[name] = definition
	end

	function core.register_chatcommand(name, definition)
		core.chatcommands[name] = definition
	end

	function core.register_on_joinplayer(callback)
		core.callbacks.joinplayer[#core.callbacks.joinplayer + 1] = callback
	end

	function core.register_on_leaveplayer(callback)
		core.callbacks.leaveplayer[#core.callbacks.leaveplayer + 1] = callback
	end

	function core.register_on_player_receive_fields(callback)
		core.callbacks.receive_fields[#core.callbacks.receive_fields + 1] = callback
	end

	function core.register_globalstep(callback)
		core.callbacks.globalstep[#core.callbacks.globalstep + 1] = callback
	end

	function core.after(seconds, callback)
		core.timers[#core.timers + 1] = { seconds = seconds, callback = callback }
	end

	function core.write_json(value)
		return encode(value)
	end

	function core.parse_json(text)
		return core.parse_queue[text]
	end

	function core.get_gametime()
		return 0
	end

	core.http_api = {}
	function core.http_api.fetch_async(request)
		core.http_requests[#core.http_requests + 1] = request
		return #core.http_requests
	end
	function core.http_api.fetch_async_get(handle)
		return core.http_results[handle] or { completed = false }
	end
	if options.disable_http then
		core.request_http_api = nil
	else
		function core.request_http_api()
			return core.http_api
		end
	end

	_G.core = core

	local H = { core = core, players = {} }

	function H.add_player(name, pos, yaw, privs)
		local player = make_player(name, pos, yaw)
		core.players[name] = player
		core.players_list[#core.players_list + 1] = player
		H.players[name] = player
		if privs then
			core.privs[name] = privs
		end
		for _, callback in ipairs(core.callbacks.joinplayer) do
			callback(player)
		end
		return player
	end

	function H.remove_player(name)
		local player = core.players[name]
		for _, callback in ipairs(core.callbacks.leaveplayer) do
			callback(player)
		end
		core.players[name] = nil
		for index, candidate in ipairs(core.players_list) do
			if candidate == player then
				table.remove(core.players_list, index)
				break
			end
		end
	end

	function H.command(name, param)
		local command = core.chatcommands.voice
		assert(command, "voice command is not registered")
		return command.func(name, param or "")
	end

	function H.fields(player_name, fields)
		local player = core.players[player_name]
		for _, callback in ipairs(core.callbacks.receive_fields) do
			callback(player, "simple_voicechat:panel", fields)
		end
	end

	function H.step(dtime)
		for _, callback in ipairs(core.callbacks.globalstep) do
			callback(dtime)
		end
	end

	function H.run_timers()
		local timers = core.timers
		core.timers = {}
		for _, timer in ipairs(timers) do
			timer.callback()
		end
	end

	function H.last_request()
		return core.http_requests[#core.http_requests]
	end

	function H.last_handle()
		return #core.http_requests
	end

	function H.requests_matching(suffix)
		local matches = {}
		for index, request in ipairs(core.http_requests) do
			if request.url:sub(-#suffix) == suffix then
				matches[#matches + 1] = { index = index, request = request }
			end
		end
		return matches
	end

	function H.pending_handle(suffix)
		for index = #core.http_requests, 1, -1 do
			local request = core.http_requests[index]
			if request.url:sub(-#suffix) == suffix and not core.http_results[index] then
				return index
			end
		end
		return nil
	end

	function H.complete(handle, result)
		core.http_results[handle] = result
		H.step(0.001)
	end

	function H.complete_json(handle, payload, text)
		text = text or "RESPONSE"
		core.parse_queue[text] = payload
		H.complete(handle, { completed = true, succeeded = true, code = 200, data = text })
	end

	-- Completes the pending sync request, creating one if needed.
	function H.sync(payload, dtime)
		local handle = H.pending_handle("/api/v1/sync")
		if not handle then
			H.step(dtime or 0.3)
			handle = H.pending_handle("/api/v1/sync")
		end
		assert(handle, "the mod did not send a sync request")
		H.complete_json(handle, payload or { players = {}, max_voice_distance = 32, whisper_distance = 8 })
		return handle
	end

	function H.last_chat(name)
		local messages = core.chat[name] or {}
		return messages[#messages]
	end

	function H.chat_contains(name, fragment)
		for _, message in ipairs(core.chat[name] or {}) do
			if message:find(fragment, 1, true) then
				return true
			end
		end
		return false
	end

	function H.last_formspec()
		local entry = core.shown_formspecs[#core.shown_formspecs]
		return entry and entry.formspec or nil
	end

	function H.hud_text(name)
		local player = core.players[name]
		local hud = player and player._hud
		if not hud then
			return nil
		end
		local text
		for _, element in pairs(hud) do
			if element.text then
				text = element.text
			end
		end
		return text
	end

	dofile("mods/simple_voicechat/init.lua")
	return H
end

return M
