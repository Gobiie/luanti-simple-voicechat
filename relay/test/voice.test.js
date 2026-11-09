import test from "node:test";
import assert from "node:assert/strict";

import { VoiceState } from "../src/voice.js";

function setup(overrides = {}) {
	const config = {
		max_voice_distance: 32,
		whisper_distance: 8,
		broadcast_range: 0,
		allow_recording: true,
		groups_enabled: true,
		max_group_members: 20,
		sync_timeout: 15,
		...overrides,
	};

	let clock = 1_000_000;
	const state = new VoiceState(config, { now: () => clock, log: () => {} });
	const clients = new Map();

	const sync = (players) => state.applySync({ players });
	const join = (name) => {
		const messages = [];
		const session = state.openSession(name, {
			send: (message) => messages.push(message),
			close: () => {},
		});
		state.recompute();
		clients.set(name, { session, messages });
		return clients.get(name);
	};

	return {
		state,
		sync,
		join,
		clients,
		tick: (ms) => {
			clock += ms;
		},
	};
}

test("players within the voice range are linked in both directions", () => {
	const env = setup();
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [10, 0, 0] },
	]);
	const alice = env.join("alice");
	const bob = env.join("bob");

	assert.equal(env.state.canHear(alice.session, bob.session), true);
	assert.equal(env.state.canHear(bob.session, alice.session), true);

	const aliceConnect = alice.messages.find((m) => m.type === "connect");
	const bobConnect = bob.messages.find((m) => m.type === "connect");
	assert.ok(aliceConnect, "alice received a connect event");
	assert.ok(bobConnect, "bob received a connect event");
	assert.notEqual(aliceConnect.initiator, bobConnect.initiator, "exactly one side initiates");
});

test("moving out of range disconnects the pair", () => {
	const env = setup();
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [5, 0, 0] },
	]);
	const alice = env.join("alice");
	const bob = env.join("bob");
	assert.ok(env.state.areLinked(alice.session, bob.session));

	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [200, 0, 0] },
	]);
	assert.equal(env.state.areLinked(alice.session, bob.session), false);
	assert.ok(alice.messages.some((m) => m.type === "disconnect"));
});

test("whispering is directional", () => {
	const env = setup();
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [10, 0, 0] },
	]);

	// A whisper keypress arrives before the session is opened in this helper,
	// so set it on the session after joining and recompute.
	const alice = env.join("alice");
	const bob = env.join("bob");
	bob.session.whispering = true;
	env.state.recompute();

	assert.equal(env.state.canHear(alice.session, bob.session), false, "alice is outside the whisper range");
	assert.equal(env.state.canHear(bob.session, alice.session), true, "bob can still hear alice at normal range");
	assert.ok(env.state.areLinked(alice.session, bob.session), "one audible direction keeps the link open");
});

test("self mute stops outgoing audio without dropping the listener", () => {
	const env = setup();
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [3, 0, 0] },
	]);
	const alice = env.join("alice");
	const bob = env.join("bob");
	bob.session.self_muted = true;
	env.state.recompute();

	assert.equal(env.state.canHear(alice.session, bob.session), false);
	assert.equal(env.state.canHear(bob.session, alice.session), true);
});

test("isolated groups only route inside the group", () => {
	const env = setup();
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [500, 0, 0] },
		{ name: "carol", pos: [1, 0, 0] },
	]);
	const alice = env.join("alice");
	const bob = env.join("bob");
	const carol = env.join("carol");

	assert.equal(env.state.joinGroup(alice.session, "raiders", "", "isolated").ok, true);
	assert.equal(env.state.joinGroup(bob.session, "raiders", "", "isolated").ok, true);

	assert.equal(env.state.canHear(alice.session, bob.session), true);
	assert.equal(env.state.canHear(bob.session, alice.session), true);
	assert.equal(env.state.canHear(carol.session, alice.session), false);
	assert.equal(env.state.canHear(alice.session, carol.session), false);

	env.state.leaveGroup(bob.session);
	assert.equal(env.state.canHear(alice.session, bob.session), false);
	// Alice is still in the group, so she does not hear or reach Carol yet.
	assert.equal(env.state.canHear(carol.session, alice.session), false);

	env.state.leaveGroup(alice.session);
	assert.equal(env.state.canHear(carol.session, alice.session), true);
});

test("normal groups hear nearby players one way", () => {
	const env = setup();
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [500, 0, 0] },
		{ name: "carol", pos: [2, 0, 0] },
	]);
	const alice = env.join("alice");
	const bob = env.join("bob");
	const carol = env.join("carol");

	env.state.joinGroup(alice.session, "team", "", "normal");
	env.state.joinGroup(bob.session, "team", "", "normal");

	assert.equal(env.state.canHear(alice.session, bob.session), true, "group ignores distance");
	assert.equal(env.state.canHear(alice.session, carol.session), true, "member hears nearby carol");
	assert.equal(env.state.canHear(carol.session, alice.session), false, "carol does not hear the group");
});

test("open groups cross the proximity boundary both ways", () => {
	const env = setup();
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "carol", pos: [2, 0, 0] },
	]);
	const alice = env.join("alice");
	const carol = env.join("carol");

	env.state.joinGroup(alice.session, "open house", "", "open");

	assert.equal(env.state.canHear(alice.session, carol.session), true);
	assert.equal(env.state.canHear(carol.session, alice.session), true);
});

test("inviting moves a player into the group without the password", () => {
	const env = setup();
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [500, 0, 0] },
	]);
	const alice = env.join("alice");
	const bob = env.join("bob");

	env.state.joinGroup(alice.session, "secret", "hunter2", "isolated");
	assert.equal(env.state.joinGroup(bob.session, "secret", "wrong", "isolated").ok, false);

	const result = env.state.inviteToGroup("alice", "bob");
	assert.equal(result.ok, true);
	assert.deepEqual(result.group.members, ["alice", "bob"]);
	assert.equal(env.state.canHear(alice.session, bob.session), true, "invited player is in the group");

	const missing = env.state.inviteToGroup("alice", "carol");
	assert.equal(missing.ok, false, "carol has no voice session");
});

test("group passwords are enforced", () => {
	const env = setup();
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [0, 0, 0] },
	]);
	const alice = env.join("alice");
	const bob = env.join("bob");

	assert.equal(env.state.joinGroup(alice.session, "secret", "hunter2").ok, true);
	const wrong = env.state.joinGroup(bob.session, "secret", "wrong");
	assert.equal(wrong.ok, false);
	assert.match(wrong.error, /password/);

	assert.equal(env.state.joinGroup(bob.session, "secret", "hunter2").ok, true);
	assert.equal(env.state.canHear(alice.session, bob.session), true);
});

test("invalid group names are rejected", () => {
	const env = setup();
	env.sync([{ name: "alice", pos: [0, 0, 0] }]);
	const alice = env.join("alice");
	assert.equal(env.state.joinGroup(alice.session, "", "").ok, false);
	assert.equal(env.state.joinGroup(alice.session, "a".repeat(25), "").ok, false);
	assert.equal(env.state.joinGroup(alice.session, "bad;name", "").ok, false);
});

test("broadcast widens only the speaker's outgoing range and ignores groups", () => {
	const env = setup({ broadcast_range: 100 });
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [60, 0, 0] },
	]);
	const alice = env.join("alice");
	const bob = env.join("bob");

	assert.equal(env.state.canHear(bob.session, alice.session), false);
	alice.session.broadcasting = true;
	env.state.recompute();

	assert.equal(env.state.canHear(bob.session, alice.session), true, "broadcast reaches bob");
	assert.equal(env.state.canHear(alice.session, bob.session), false, "bob is still too far to reach alice");
});

test("broadcast is disabled when broadcast_range is zero", () => {
	const env = setup({ broadcast_range: 0 });
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [60, 0, 0] },
	]);
	const alice = env.join("alice");
	const bob = env.join("bob");
	alice.session.broadcasting = true;
	env.state.recompute();
	assert.equal(env.state.canHear(bob.session, alice.session), false);
});

test("players who disable voice are dropped and cannot hear", () => {
	const env = setup();
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [0, 0, 0] },
	]);
	const alice = env.join("alice");
	const bob = env.join("bob");
	assert.ok(env.state.areLinked(alice.session, bob.session));

	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [0, 0, 0], voice: false },
	]);
	assert.equal(env.state.sessionByName("bob"), undefined);
	assert.equal(env.state.canHear(alice.session, bob.session), false);
});

test("admin mute blocks outgoing audio but keeps the session", () => {
	const env = setup();
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [1, 0, 0] },
	]);
	const alice = env.join("alice");
	const bob = env.join("bob");

	assert.equal(env.state.setAdminMute("bob", true), true);
	assert.equal(env.state.canHear(alice.session, bob.session), false);
	assert.equal(env.state.canHear(bob.session, alice.session), true);
	assert.ok(bob.messages.some((m) => m.type === "admin_mute" && m.muted === true));

	env.state.setAdminMute("bob", false);
	assert.equal(env.state.canHear(alice.session, bob.session), true);
});

test("kicking removes the session and notifies peers", () => {
	const env = setup();
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [1, 0, 0] },
	]);
	const alice = env.join("alice");
	env.join("bob");

	assert.equal(env.state.kickPlayer("bob"), true);
	assert.equal(env.state.sessions.size, 1);
	assert.equal(env.state.sessionByName("bob"), undefined);
	assert.ok(alice.messages.some((m) => m.type === "peer.left" && m.peer.name === "bob"));
});

test("stale game server connections drop all voice sessions", () => {
	const env = setup({ sync_timeout: 10 });
	env.sync([{ name: "alice", pos: [0, 0, 0] }]);
	env.join("alice");
	env.tick(15_000);
	env.state.checkStale();
	assert.equal(env.state.sessions.size, 0);
});

test("a new sync keeps sessions alive", () => {
	const env = setup({ sync_timeout: 10 });
	env.sync([{ name: "alice", pos: [0, 0, 0] }]);
	env.join("alice");
	env.tick(5_000);
	env.sync([{ name: "alice", pos: [0, 0, 0] }]);
	env.tick(5_000);
	env.state.checkStale();
	assert.equal(env.state.sessions.size, 1);
});

test("status payload reports groups, speaking and mute state", () => {
	const env = setup();
	env.sync([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [2, 0, 0] },
	]);
	const alice = env.join("alice");
	env.join("bob");
	env.state.joinGroup(alice.session, "team", "");
	alice.session.speaking = true;
	env.state.setAdminMute("bob", true);

	const status = env.state.statusForMod();
	assert.equal(status.players.alice.connected, true);
	assert.equal(status.players.alice.group, "team");
	assert.equal(status.players.alice.speaking, true);
	assert.equal(status.players.bob.admin_muted, true);
	assert.equal(status.max_voice_distance, 32);
	assert.equal(status.allow_recording, true);
});

test("rejoining with the same name replaces the old session", () => {
	const env = setup();
	env.sync([{ name: "alice", pos: [0, 0, 0] }]);
	const first = env.join("alice");
	const second = env.join("alice");

	assert.notEqual(first.session.id, second.session.id);
	assert.equal(env.state.sessions.size, 1);
	assert.equal(env.state.sessionByName("alice").id, second.session.id);
});
