-- Exercises mods/simple_voicechat/init.lua against tests/lua/harness.lua.
-- Run from the project root:  lua tests/lua/mod_test.lua

package.path = "tests/lua/?.lua;" .. package.path
local harness = require("harness")

local passed, failed = 0, 0
local failures = {}

local function test(name, fn)
	local ok, err = pcall(fn)
	if ok then
		passed = passed + 1
		print("ok   " .. name)
	else
		failed = failed + 1
		failures[#failures + 1] = name .. ": " .. tostring(err)
		print("FAIL " .. name .. "\n     " .. tostring(err))
	end
end

local function eq(actual, expected, label)
	if actual ~= expected then
		error((label or "value") .. ": expected " .. tostring(expected) .. ", got " .. tostring(actual), 2)
	end
end

local function truthy(value, label)
	if not value then
		error((label or "value") .. " should be truthy", 2)
	end
end

local function contains(haystack, needle, label)
	if type(haystack) ~= "string" or not haystack:find(needle, 1, true) then
		error(
			(label or "text") .. ": expected to contain [" .. needle .. "], got [" .. tostring(haystack) .. "]",
			2
		)
	end
end

local function base_settings(extra)
	local settings = {
		["simple_voicechat.relay_url"] = "http://127.0.0.1:8090",
		["simple_voicechat.secret"] = "test-secret",
		["simple_voicechat.sync_interval"] = 0.25,
		["simple_voicechat.hud"] = true,
		["simple_voicechat.join_hint"] = false,
		["simple_voicechat.nametag_indicators"] = true,
	}
	for key, value in pairs(extra or {}) do
		settings[key] = value
	end
	return settings
end

local function standard(extra)
	local H = harness.setup({
		settings = base_settings(extra),
		privs = { alice = { voice_admin = true }, bob = {} },
	})
	local alice = H.add_player("alice", { x = 0, y = 0, z = 0 }, 0, { voice_admin = true })
	local bob = H.add_player("bob", { x = 5, y = 0, z = 1.234 }, 1.5, {})
	return H, alice, bob
end

-- --------------------------------------------------------------- load-time

test("registers the voice command, privilege and globalstep", function()
	local H = standard()
	truthy(H.core.chatcommands.voice, "voice command")
	truthy(H.core.privileges.voice_admin, "voice_admin privilege")
	truthy(H.core.callbacks.globalstep[1], "globalstep")
	eq(#H.core.logs > 0, true, "startup log")
	contains(H.core.logs[#H.core.logs].message, "http://127.0.0.1:8090")
end)

test("warns when the HTTP API is unavailable", function()
	local H = harness.setup({
		disable_http = true,
		settings = base_settings(),
	})
	local warned = false
	for _, entry in ipairs(H.core.logs) do
		if entry.level == "warning" and entry.message:find("secure.http_mods", 1, true) then warned = true end
	end
	eq(warned, true, "warning about secure.http_mods")
end)

test("warns when the relay URL or secret is missing", function()
	local H = harness.setup({
		settings = { ["simple_voicechat.relay_url"] = "" },
	})
	local warned = false
	for _, entry in ipairs(H.core.logs) do
		if entry.level == "warning" and entry.message:find("relay_url", 1, true) then warned = true end
	end
	eq(warned, true, "warning about relay settings")
end)

-- ------------------------------------------------------------------ codes

test("/voice requests a code with the shared secret", function()
	local H = standard()
	local ok = H.command("alice", "")
	eq(ok, true, "command result")

	local request = H.last_request()
	truthy(request, "a request was made")
	contains(request.url, "/api/v1/token", "token endpoint")
	contains(request.data, '"player":"alice"', "request body")

	local authorized = false
	for _, header in ipairs(request.extra_headers) do
		if header == "Authorization: Bearer test-secret" then authorized = true end
	end
	eq(authorized, true, "authorization header")
	eq(request.method, "POST", "method")
end)

test("a completed code request is shown in chat and in the panel", function()
	local H = standard()
	H.command("alice", "")
	H.complete_json(H.last_handle(), {
		code = "ABC123",
		url = "https://voice.example.com/?t=long-token",
		expires_in = 120,
	})

	eq(simple_voicechat.get_join_code("alice"), "ABC123", "join code")
	contains(H.last_chat("alice"), "ABC123", "chat message")
	contains(H.last_chat("alice"), "https://voice.example.com/?t=long-token", "chat link")

	H.command("alice", "")
	contains(H.last_formspec(), "Simple Voice Chat", "panel title")
	contains(H.last_formspec(), "ABC123", "panel code")
	contains(H.last_formspec(), "https://voice.example.com/?t=long-token", "panel url")
end)

test("the panel refresh button requests a fresh code", function()
	local H = standard()
	H.command("alice", "")
	H.complete_json(H.last_handle(), { code = "AAA111", url = "http://relay/?t=1", expires_in = 120 })

	local before = #H.core.http_requests
	H.fields("alice", { refresh = true })
	eq(#H.core.http_requests, before + 1, "new token request")
	contains(H.last_request().url, "/api/v1/token", "endpoint")
end)

test("a failed token request is reported instead of crashing", function()
	local H = standard()
	H.command("alice", "")
	H.complete(H.last_handle(), { completed = true, succeeded = false, code = 401 })
	contains(H.last_chat("alice"), "shared secret", "error message")
	eq(simple_voicechat.get_join_code("alice"), nil, "no code stored")
end)

-- ------------------------------------------------------------------- sync

test("sync sends rounded positions, yaw and the voice flag", function()
	local H = standard()
	H.step(0.3)

	local handle = H.pending_handle("/api/v1/sync")
	truthy(handle, "sync request")
	local data = H.core.http_requests[handle].data
	contains(data, '"name":"alice"', "alice in payload")
	contains(data, '"name":"bob"', "bob in payload")
	contains(data, '"pos":[0,0,0]', "alice position")
	contains(data, '"pos":[5,0,1.23]', "rounded bob position")
	contains(data, '"yaw":1.5', "yaw")
	contains(data, '"voice":true', "voice flag")
	contains(H.core.http_requests[handle].url, "/api/v1/sync", "endpoint")
end)

test("relay status updates the HUD, config and API", function()
	local H = standard()
	H.sync({
		players = {
			alice = { connected = true, speaking = false, admin_muted = false, group = "hunters" },
			bob = { connected = true, speaking = false, admin_muted = false },
		},
		max_voice_distance = 40,
		whisper_distance = 10,
		broadcast_range = 96,
		allow_recording = true,
	})

	eq(simple_voicechat.is_connected("alice"), true, "alice connected")
	eq(simple_voicechat.is_connected("bob"), true, "bob connected")
	eq(simple_voicechat.is_connected("nobody"), false, "unknown player")

	local config = simple_voicechat.get_config()
	eq(config.online, true, "online")
	eq(config.max_voice_distance, 40, "range")
	eq(config.whisper_distance, 10, "whisper range")
	eq(config.broadcast_range, 96, "broadcast range")
	eq(config.allow_recording, true, "recording allowed")

	contains(H.hud_text("alice"), "group hunters", "hud group text")
end)

test("an unreachable relay is reported without breaking the game", function()
	local H = standard()
	H.step(0.3)
	local handle = H.pending_handle("/api/v1/sync")
	H.complete(handle, { completed = true, succeeded = false, code = 0 })

	local config = simple_voicechat.get_config()
	eq(config.online, false, "offline")
	contains(config.error, "unreachable", "error text")
	eq(simple_voicechat.get_status("alice"), nil, "no status")
end)

test("a timeout is described as a timeout", function()
	local H = standard()
	H.step(0.3)
	local handle = H.pending_handle("/api/v1/sync")
	H.complete(handle, { completed = true, succeeded = false, code = 28, timeout = true })
	contains(simple_voicechat.get_config().error, "timed out", "timeout text")
end)

test("speaking tints the nametag, updates the HUD and notifies listeners", function()
	local H, alice = standard()
	local events = {}
	simple_voicechat.register_on_status_change(function(name, info)
		events[#events + 1] = { name = name, info = info }
	end)

	H.sync({
		players = {
			alice = { connected = true, speaking = false, admin_muted = false },
			bob = { connected = true, speaking = false, admin_muted = false },
		},
	})
	eq(alice._nametag.color, "#FFFFFF", "initial nametag colour")

	H.sync({
		players = {
			alice = { connected = true, speaking = true, admin_muted = false },
			bob = { connected = true, speaking = false, admin_muted = false },
		},
	})
	eq(alice._nametag.color, "#7CFF9B", "speaking nametag colour")
	contains(H.hud_text("alice"), "talking", "hud talking")

	local sawSpeaking = false
	for _, event in ipairs(events) do
		if event.name == "alice" and event.info and event.info.speaking then sawSpeaking = true end
	end
	eq(sawSpeaking, true, "listener saw speaking")

	H.sync({
		players = {
			alice = { connected = true, speaking = false, admin_muted = false },
			bob = { connected = true, speaking = false, admin_muted = false },
		},
	})
	eq(alice._nametag.color, "#FFFFFF", "restored nametag colour")
end)

test("disabling voice is reflected in the next sync", function()
	local H, alice = standard()
	H.sync({ players = { alice = { connected = true }, bob = { connected = true } } })

	H.command("alice", "disable")
	eq(alice._meta.ints["simple_voicechat_disabled"], 1, "meta flag")

	local handle = H.pending_handle("/api/v1/sync")
	truthy(handle, "sync after disabling")
	contains(H.core.http_requests[handle].data, '"voice":false', "opt-out in payload")
	contains(H.last_chat("alice"), "disabled", "confirmation")

	H.command("alice", "enable")
	eq(alice._meta.ints["simple_voicechat_disabled"], 0, "meta flag cleared")
end)

test("the panel toggle button flips the opt-out and rerenders", function()
	local H, alice = standard()
	H.command("alice", "")
	H.complete_json(H.last_handle(), { code = "ABC123", url = "http://relay/?t=x", expires_in = 120 })

	H.fields("alice", { toggle = true })
	eq(alice._meta.ints["simple_voicechat_disabled"], 1, "disabled by toggle")
	contains(H.last_formspec(), "Enable my voice", "label switches")

	H.fields("alice", { toggle = true })
	eq(alice._meta.ints["simple_voicechat_disabled"], 0, "enabled again")
end)

test("force voice chat shows a nag for players without a session", function()
	local H = standard({ ["simple_voicechat.force_voice_chat"] = true })
	H.sync({ players = { alice = { connected = false }, bob = { connected = false } } })
	contains(H.hud_text("alice"), "required", "nag text")
end)

test("the HUD can be turned off", function()
	local H = standard({ ["simple_voicechat.hud"] = false })
	H.sync({ players = { alice = { connected = true }, bob = { connected = true } } })
	eq(H.hud_text("alice"), nil, "no hud")
end)

-- --------------------------------------------------------------- moderation

test("admin commands require the voice_admin privilege", function()
	local H = standard()
	local ok, message = H.command("bob", "admin mute alice")
	eq(ok, false, "refused")
	contains(message, "voice_admin", "explains the privilege")
end)

test("admin mute and unmute call the relay with the right body", function()
	local H = standard()

	H.command("alice", "admin mute bob")
	contains(H.last_request().url, "/api/v1/admin/mute", "mute endpoint")
	contains(H.last_request().data, '"muted":true', "mute body")

	H.command("alice", "admin unmute bob")
	contains(H.last_request().url, "/api/v1/admin/mute", "unmute endpoint")
	contains(H.last_request().data, '"muted":false', "unmute body")
end)

test("admin kick calls the relay", function()
	local H = standard()
	H.command("alice", "admin kick bob")
	contains(H.last_request().url, "/api/v1/admin/kick", "kick endpoint")
	contains(H.last_request().data, '"player":"bob"', "kick target")
end)

test("admin groups lists open groups", function()
	local H = standard()
	H.command("alice", "admin groups")
	contains(H.last_request().url, "/api/v1/admin/groups", "groups endpoint")

	H.complete_json(H.last_handle(), { groups = { { name = "hunters", type = "open", members = { "bob" }, locked = false } } })
	contains(H.last_chat("alice"), "hunters", "group listed")
	contains(H.last_chat("alice"), "open", "group type listed")
end)

test("admin usage errors are explicit", function()
	local H = standard()
	local ok, message = H.command("alice", "admin mute")
	eq(ok, false, "refused")
	contains(message, "Usage", "usage text")
end)

-- --------------------------------------------------------------- lifecycle

test("the join hint fires once and mentions /voice", function()
	local H = harness.setup({
		settings = base_settings({ ["simple_voicechat.join_hint"] = true }),
	})
	H.add_player("dana", { x = 1, y = 2, z = 3 }, 0, {})
	H.run_timers()
	contains(H.last_chat("dana"), "/voice", "join hint")
end)

test("leaving clears HUD and status state", function()
	local H = standard()
	H.sync({ players = { alice = { connected = true }, bob = { connected = true } } })
	truthy(H.hud_text("alice"), "hud before leaving")
	H.remove_player("alice")
	eq(H.hud_text("alice"), nil, "hud after leaving")
	eq(simple_voicechat.get_status("alice"), nil, "status cleared")
end)

test("status command reports connected players and groups", function()
	local H = standard()
	H.sync({
		players = {
			alice = { connected = true, group = "hunters" },
			bob = { connected = false },
		},
		max_voice_distance = 32,
		whisper_distance = 8,
	})
	H.command("alice", "status")
	eq(H.chat_contains("alice", "1 of 2 players"), true, "counts")
	eq(H.chat_contains("alice", "hunters"), true, "group list")
end)

test("unknown subcommands show usage", function()
	local H = standard()
	local ok, message = H.command("alice", "nonsense")
	eq(ok, false, "refused")
	contains(message, "Usage", "usage text")
end)

-- --------------------------------------------------------------- invites

test("/voice invite asks the relay to add a player to the group", function()
	local H = standard()
	H.sync({ players = { alice = { connected = true }, bob = { connected = true } } })

	local ok = H.command("alice", "invite bob")
	eq(ok, true, "command result")
	contains(H.last_request().url, "/api/v1/admin/invite", "endpoint")
	contains(H.last_request().data, '"from":"alice"', "inviter")
	contains(H.last_request().data, '"player":"bob"', "target")

	H.complete_json(H.last_handle(), { ok = true })
	contains(H.last_chat("alice"), "invited bob", "confirmation")
end)

test("/voice invite needs a target and an active voice session", function()
	local H = standard()
	local ok, message = H.command("alice", "invite")
	eq(ok, false, "missing target")
	contains(message, "Usage", "usage text")

	H.sync({ players = { alice = { connected = false }, bob = { connected = true } } })
	local joined, why = H.command("alice", "invite bob")
	eq(joined, false, "refused without a session")
	contains(why, "Join voice chat first", "explains why")
end)

print("")
print(string.format("%d passed, %d failed", passed, failed))
if failed > 0 then
	for _, failure in ipairs(failures) do
		print("  - " .. failure)
	end
	os.exit(1)
end
