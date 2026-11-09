import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { createVoiceServer } from "../src/server.js";

const RELAY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "test-secret-0123456789abcdef";

function makeConfig(overrides = {}) {
	return {
		host: "127.0.0.1",
		port: 0,
		secret: SECRET,
		max_voice_distance: 32,
		whisper_distance: 8,
		broadcast_range: 0,
		allow_recording: true,
		groups_enabled: true,
		max_group_members: 20,
		sync_timeout: 30,
		token_ttl: 120,
		require_known_player: true,
		public_url: "",
		ice_servers: [],
		invert_pan: false,
		tls: null,
		public_dir: path.join(RELAY_ROOT, "public"),
		...overrides,
	};
}

async function startRelay(overrides = {}, log = () => {}) {
	const { server, close, state, tokens } = createVoiceServer(makeConfig(overrides), { log });
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address();
	return { base: `http://127.0.0.1:${port}`, close, state, tokens, port };
}

async function api(base, endpoint, body, secret = SECRET) {
	const response = await fetch(`${base}${endpoint}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
		},
		body: JSON.stringify(body ?? {}),
	});
	const text = await response.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* not json */
	}
	return { status: response.status, json, text };
}

function sync(base, players) {
	return api(base, "/api/v1/sync", { players });
}

async function openClient(port) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const messages = [];
	const waiters = [];
	ws.on("message", (raw) => {
		const message = JSON.parse(raw.toString("utf8"));
		messages.push(message);
		for (const waiter of [...waiters]) {
			if (!waiter.predicate(message)) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			clearTimeout(waiter.timer);
			waiter.resolve(message);
		}
	});

	return {
		ws,
		messages,
		send: (message) => ws.send(JSON.stringify(message)),
		wait(predicate, timeout = 3000) {
			const existing = messages.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const waiter = { predicate, resolve };
				waiter.timer = setTimeout(() => {
					waiters.splice(waiters.indexOf(waiter), 1);
					reject(new Error("timed out waiting for websocket message"));
				}, timeout);
				waiters.push(waiter);
			});
		},
		close: () =>
			new Promise((resolve) => {
				if (ws.readyState === WebSocket.CLOSED) return resolve();
				ws.once("close", resolve);
				ws.close();
			}),
	};
}

async function authenticated(port, code) {
	const client = await openClient(port);
	client.send({ type: "auth", token: code });
	const welcome = await client.wait((m) => m.type === "welcome");
	return { client, welcome };
}

test("health endpoint and API authentication", async (t) => {
	const relay = await startRelay();
	t.after(() => relay.close());

	const health = await fetch(`${relay.base}/health`);
	assert.equal(health.status, 200);
	assert.equal((await health.json()).ok, true);

	const noAuth = await api(relay.base, "/api/v1/sync", { players: [] }, null);
	assert.equal(noAuth.status, 401);

	const wrong = await api(relay.base, "/api/v1/sync", { players: [] }, "nope");
	assert.equal(wrong.status, 401);

	const ok = await sync(relay.base, []);
	assert.equal(ok.status, 200);
	assert.equal(ok.json.ok, true);
});

test("error responses are written once and do not log header errors", async (t) => {
	const logs = [];
	const relay = await startRelay({}, (level, message) => logs.push({ level, message }));
	t.after(() => relay.close());

	const health = await fetch(`${relay.base}/health`);
	assert.equal(health.status, 200);
	await health.text();

	const missing = await api(relay.base, "/api/v1/token", {});
	assert.equal(missing.status, 400);

	const unauth = await api(relay.base, "/api/v1/sync", {}, null);
	assert.equal(unauth.status, 401);

	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(
		logs.filter((entry) => entry.message.includes("ERR_HTTP_HEADERS_SENT")).length,
		0,
		"no response is written twice"
	);
});

test("tokens are only issued for players in the game", async (t) => {
	const relay = await startRelay();
	t.after(() => relay.close());

	await sync(relay.base, [{ name: "alice", pos: [0, 0, 0], yaw: 0 }]);

	const missing = await api(relay.base, "/api/v1/token", { player: "ghost" });
	assert.equal(missing.status, 409);

	const granted = await api(relay.base, "/api/v1/token", { player: "alice" });
	assert.equal(granted.status, 200);
	assert.match(granted.json.code, /^[A-HJ-NP-Z2-9]{6}$/);
	assert.match(granted.json.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
});

test("websocket rejects bad tokens and accepts a valid code", async (t) => {
	const relay = await startRelay();
	t.after(() => relay.close());

	await sync(relay.base, [{ name: "alice", pos: [0, 0, 0] }]);
	const grant = await api(relay.base, "/api/v1/token", { player: "alice" });

	const bad = await openClient(relay.port);
	bad.send({ type: "auth", token: "NOPE00" });
	const closed = await new Promise((resolve) => bad.ws.once("close", (code) => resolve(code)));
	assert.equal(closed, 4003);

	const good = await authenticated(relay.port, grant.json.code);
	const { welcome } = good;
	assert.equal(welcome.you.name, "alice");
	assert.equal(welcome.config.max_voice_distance, 32);
	assert.equal(welcome.config.invert_pan, false);
	await good.client.close();
});

test("two clients are linked and can relay signaling", async (t) => {
	const relay = await startRelay();
	t.after(() => relay.close());

	await sync(relay.base, [
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [5, 0, 0] },
	]);
	const aliceGrant = await api(relay.base, "/api/v1/token", { player: "alice" });
	const bobGrant = await api(relay.base, "/api/v1/token", { player: "bob" });

	const alice = await authenticated(relay.port, aliceGrant.json.code);
	const bob = await authenticated(relay.port, bobGrant.json.code);

	const aliceConnect = await alice.client.wait((m) => m.type === "connect");
	assert.equal(aliceConnect.peer.name, "bob");

	const bobConnect = await bob.client.wait((m) => m.type === "connect");
	assert.equal(bobConnect.peer.name, "alice");
	assert.equal(aliceConnect.initiator, !bobConnect.initiator, "exactly one side initiates");

	const aliceLink = await alice.client.wait((m) => m.type === "link");
	assert.equal(aliceLink.hear, true);

	alice.client.send({ type: "signal", to: aliceConnect.peer.id, data: { sdp: { type: "offer", sdp: "v=0" } } });
	const forwarded = await bob.client.wait((m) => m.type === "signal");
	assert.equal(forwarded.from, alice.welcome.you.id);
	assert.equal(forwarded.data.sdp.sdp, "v=0");

	await alice.client.close();
	await bob.client.close();
});

test("groups connect distant players and leaving restores proximity", async (t) => {
	const relay = await startRelay();
	t.after(() => relay.close());

	await sync(relay.base, [
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [300, 0, 0] },
	]);
	const aliceGrant = await api(relay.base, "/api/v1/token", { player: "alice" });
	const bobGrant = await api(relay.base, "/api/v1/token", { player: "bob" });
	const alice = await authenticated(relay.port, aliceGrant.json.code);
	const bob = await authenticated(relay.port, bobGrant.json.code);

	bob.client.send({ type: "group.join", name: "distant friends", password: "pw", groupType: "isolated" });
	const group = await bob.client.wait((m) => m.type === "group");
	assert.equal(group.group.name, "distant friends");
	assert.equal(group.group.locked, true);
	assert.equal(group.group.type, "isolated");

	// Groups are exclusive, so both players must join before any link exists.
	alice.client.send({ type: "group.join", name: "distant friends", password: "pw" });
	const aliceGroup = await alice.client.wait((m) => m.type === "group");
	assert.equal(aliceGroup.group.name, "distant friends");
	assert.deepEqual(aliceGroup.group.members, ["alice", "bob"]);

	const connect = await alice.client.wait((m) => m.type === "connect");
	assert.equal(connect.peer.name, "bob");

	bob.client.send({ type: "group.leave" });
	await bob.client.wait((m) => m.type === "disconnect");

	await alice.client.close();
	await bob.client.close();
});

test("whispering updates link flags without tearing the link down", async (t) => {
	const relay = await startRelay();
	t.after(() => relay.close());

	await sync(relay.base, [
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [10, 0, 0] },
	]);
	const aliceGrant = await api(relay.base, "/api/v1/token", { player: "alice" });
	const bobGrant = await api(relay.base, "/api/v1/token", { player: "bob" });
	const alice = await authenticated(relay.port, aliceGrant.json.code);
	const bob = await authenticated(relay.port, bobGrant.json.code);

	await alice.client.wait((m) => m.type === "link");
	bob.client.send({ type: "whisper", on: true });

	const flags = await alice.client.wait((m) => m.type === "link" && m.peer.name === "bob" && m.hear === false);
	assert.equal(flags.hear, false);

	await alice.client.close();
	await bob.client.close();
});

test("admin mute and kick routes affect live sessions", async (t) => {
	const relay = await startRelay();
	t.after(() => relay.close());

	await sync(relay.base, [
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [1, 0, 0] },
	]);
	const aliceGrant = await api(relay.base, "/api/v1/token", { player: "alice" });
	const bobGrant = await api(relay.base, "/api/v1/token", { player: "bob" });
	const alice = await authenticated(relay.port, aliceGrant.json.code);
	const bob = await authenticated(relay.port, bobGrant.json.code);

	await alice.client.wait((m) => m.type === "link");

	const unknown = await api(relay.base, "/api/v1/admin/mute", { player: "ghost", muted: true });
	assert.equal(unknown.status, 404);

	const muted = await api(relay.base, "/api/v1/admin/mute", { player: "bob", muted: true });
	assert.equal(muted.status, 200);
	await bob.client.wait((m) => m.type === "admin_mute" && m.muted === true);
	await alice.client.wait((m) => m.type === "link" && m.peer.name === "bob" && m.hear === false);

	const closed = new Promise((resolve) => bob.client.ws.once("close", (closeCode) => resolve(closeCode)));
	const kicked = await api(relay.base, "/api/v1/admin/kick", { player: "bob" });
	assert.equal(kicked.status, 200);
	assert.equal(await closed, 4001);
	await alice.client.wait((m) => m.type === "peer.left");

	await alice.client.close();
});

test("leaving the game drops the voice session", async (t) => {
	const relay = await startRelay();
	t.after(() => relay.close());

	await sync(relay.base, [
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [1, 0, 0] },
	]);
	const bobGrant = await api(relay.base, "/api/v1/token", { player: "bob" });
	const bob = await authenticated(relay.port, bobGrant.json.code);
	const closed = new Promise((resolve) => bob.client.ws.once("close", (closeCode) => resolve(closeCode)));

	await sync(relay.base, [{ name: "alice", pos: [0, 0, 0] }]);
	assert.equal(await closed, 4001);

	await bob.client.close().catch(() => {});
});

test("serves the voice panel and refuses path traversal", async (t) => {
	const relay = await startRelay();
	t.after(() => relay.close());

	const page = await fetch(`${relay.base}/`);
	assert.equal(page.status, 200);
	assert.match(page.headers.get("content-type"), /text\/html/);
	assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
	assert.match(await page.text(), /Simple Voice Chat/);

	const script = await fetch(`${relay.base}/app.js`);
	assert.equal(script.status, 200);
	assert.match(script.headers.get("content-type"), /javascript/);

	const traversal = await fetch(`${relay.base}/..%2F..%2Fetc%2Fpasswd`);
	assert.equal(traversal.status, 404);

	const missing = await fetch(`${relay.base}/nope.js`);
	assert.equal(missing.status, 404);
});

test("unknown API routes return JSON 404s", async (t) => {
	const relay = await startRelay();
	t.after(() => relay.close());

	const response = await api(relay.base, "/api/v1/nope", {});
	assert.equal(response.status, 404);
	assert.match(response.json.error, /unknown/);
});

test("broadcast range is reported to clients", async (t) => {
	const relay = await startRelay({ broadcast_range: 128 });
	t.after(() => relay.close());

	await sync(relay.base, [{ name: "alice", pos: [0, 0, 0] }]);
	const grant = await api(relay.base, "/api/v1/token", { player: "alice" });
	const alice = await authenticated(relay.port, grant.json.code);

	assert.equal(alice.welcome.config.broadcast_range, 128);
	alice.client.send({ type: "broadcast", on: true });
	await alice.client.wait((m) => m.type === "broadcast" && m.on === true);
	assert.equal(relay.state.sessionByName("alice").broadcasting, true);

	await alice.client.close();
});

test("an admin invite moves a player into the inviter's group", async (t) => {
	const relay = await startRelay();
	t.after(() => relay.close());

	await sync(relay.base, [
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [400, 0, 0] },
	]);
	const aliceGrant = await api(relay.base, "/api/v1/token", { player: "alice" });
	const bobGrant = await api(relay.base, "/api/v1/token", { player: "bob" });
	const alice = await authenticated(relay.port, aliceGrant.json.code);
	const bob = await authenticated(relay.port, bobGrant.json.code);

	alice.client.send({ type: "group.join", name: "raiders", password: "pw", groupType: "isolated" });
	await alice.client.wait((m) => m.type === "group" && m.group?.name === "raiders");

	const notInGroup = await api(relay.base, "/api/v1/admin/invite", { from: "bob", player: "alice" });
	assert.equal(notInGroup.status, 409);

	const invited = await api(relay.base, "/api/v1/admin/invite", { from: "alice", player: "bob" });
	assert.equal(invited.status, 200);
	assert.deepEqual(invited.json.group.members, ["alice", "bob"]);

	const bobGroup = await bob.client.wait((m) => m.type === "group" && m.group?.name === "raiders");
	assert.equal(bobGroup.group.type, "isolated");
	const connect = await alice.client.wait((m) => m.type === "connect");
	assert.equal(connect.peer.name, "bob");

	await alice.client.close();
	await bob.client.close();
});

test("a websocket invite adds a player and notifies both sides", async (t) => {
	const relay = await startRelay();
	t.after(() => relay.close());

	await sync(relay.base, [
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [400, 0, 0] },
	]);
	const aliceGrant = await api(relay.base, "/api/v1/token", { player: "alice" });
	const bobGrant = await api(relay.base, "/api/v1/token", { player: "bob" });
	const alice = await authenticated(relay.port, aliceGrant.json.code);
	const bob = await authenticated(relay.port, bobGrant.json.code);

	alice.client.send({ type: "group.join", name: "invitees", groupType: "isolated" });
	await alice.client.wait((m) => m.type === "group" && m.group?.name === "invitees");

	alice.client.send({ type: "group.invite", player: "bob" });
	await alice.client.wait((m) => m.type === "notice" && m.message.includes("Invited bob"));

	const bobGroup = await bob.client.wait((m) => m.type === "group" && m.group?.name === "invitees");
	assert.deepEqual(bobGroup.group.members, ["alice", "bob"]);
	const notice = await bob.client.wait((m) => m.type === "notice");
	assert.match(notice.message, /added to the group/);
	const connect = await alice.client.wait((m) => m.type === "connect");
	assert.equal(connect.peer.name, "bob");

	await alice.client.close();
	await bob.client.close();
});
