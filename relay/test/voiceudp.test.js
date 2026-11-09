import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";

import { VoiceState } from "../src/voice.js";
import { TokenStore } from "../src/tokens.js";
import {
	VOICE_FLAG,
	VOICE_PACKET,
	buildAudio,
	buildHello,
	buildState,
	createVoiceUdpServer,
	parseServerAudio,
	parseText,
	parseWelcome,
} from "../src/voiceudp.js";

const BASE_CONFIG = {
	max_voice_distance: 32,
	whisper_distance: 8,
	broadcast_range: 0,
	allow_recording: true,
	groups_enabled: true,
	max_group_members: 20,
	sync_timeout: 15,
	voice_udp_host: "127.0.0.1",
	voice_udp_port: 0,
};

function bind(socket) {
	return new Promise((resolve, reject) => {
		socket.once("error", reject);
		socket.bind(0, "127.0.0.1", () => {
			socket.removeListener("error", reject);
			resolve(socket.address());
		});
	});
}

function receive(socket, timeout = 500) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			socket.off("message", onMessage);
			resolve(null);
		}, timeout);
		function onMessage(message) {
			clearTimeout(timer);
			socket.off("message", onMessage);
			resolve(message);
		}
		socket.on("message", onMessage);
	});
}

function closeSocket(socket) {
	return new Promise((resolve) => {
		try {
			socket.close(() => resolve());
		} catch {
			resolve();
		}
	});
}

function makeEnv(players = [
	{ name: "alice", pos: [0, 0, 0] },
	{ name: "bob", pos: [10, 0, 0] },
]) {
	const config = { ...BASE_CONFIG };
	const state = new VoiceState(config, { log: () => {} });
	state.applySync({ players });
	const tokens = new TokenStore(60_000);
	const udp = createVoiceUdpServer({ config, state, tokens, log: () => {} });
	return { config, state, tokens, udp };
}

async function join(socket, udp, token) {
	socket.send(buildHello(token), udp.socket.address().port, "127.0.0.1");
	const response = await receive(socket);
	assert.ok(response, "expected a WELCOME response");
	const welcome = parseWelcome(response);
	assert.ok(welcome, "expected a valid WELCOME packet");
	return welcome;
}

test("native client audio is forwarded to an audible peer with its position", async () => {
	const { state, tokens, udp } = makeEnv();
	const alice = dgram.createSocket("udp4");
	const bob = dgram.createSocket("udp4");
	try {
		await bind(alice);
		await bind(bob);
		await udp.listen(0, "127.0.0.1");

		const aliceWelcome = await join(alice, udp, tokens.issue("alice").token);
		const bobWelcome = await join(bob, udp, tokens.issue("bob").token);
		assert.equal(aliceWelcome.name, "alice");
		assert.notEqual(aliceWelcome.udpId, bobWelcome.udpId);

		alice.send(buildAudio(1, 1234, Buffer.from([9, 8, 7, 6])), udp.socket.address().port, "127.0.0.1");
		const response = await receive(bob);
		assert.ok(response, "bob should receive alice's audio");
		const audio = parseServerAudio(response);
		assert.ok(audio);
		assert.equal(audio.senderName, "alice");
		assert.equal(audio.senderId, aliceWelcome.udpId);
		assert.equal(audio.sequence, 1);
		assert.deepEqual([...audio.payload], [9, 8, 7, 6]);
		assert.deepEqual(audio.position, [0, 0, 0]);
	} finally {
		await udp.close();
		await closeSocket(alice);
		await closeSocket(bob);
	}
});

test("audio stops when the listener moves out of range", async () => {
	const { state, tokens, udp } = makeEnv();
	const alice = dgram.createSocket("udp4");
	const bob = dgram.createSocket("udp4");
	try {
		await bind(alice);
		await bind(bob);
		await udp.listen(0, "127.0.0.1");
		await join(alice, udp, tokens.issue("alice").token);
		await join(bob, udp, tokens.issue("bob").token);

		state.applySync({
			players: [
				{ name: "alice", pos: [0, 0, 0] },
				{ name: "bob", pos: [500, 0, 0] },
			],
		});

		alice.send(buildAudio(2, 2000, Buffer.from([1, 2, 3])), udp.socket.address().port, "127.0.0.1");
		assert.equal(await receive(bob, 250), null, "bob is too far away");
	} finally {
		await udp.close();
		await closeSocket(alice);
		await closeSocket(bob);
	}
});

test("self mute and whisper flags affect routing", async () => {
	const { state, tokens, udp } = makeEnv([
		{ name: "alice", pos: [0, 0, 0] },
		{ name: "bob", pos: [10, 0, 0] },
	]);
	const alice = dgram.createSocket("udp4");
	const bob = dgram.createSocket("udp4");
	try {
		await bind(alice);
		await bind(bob);
		await udp.listen(0, "127.0.0.1");
		await join(alice, udp, tokens.issue("alice").token);
		await join(bob, udp, tokens.issue("bob").token);

		alice.send(buildState(VOICE_FLAG.SELF_MUTED), udp.socket.address().port, "127.0.0.1");
		alice.send(buildAudio(3, 3000, Buffer.from([4, 5, 6])), udp.socket.address().port, "127.0.0.1");
		assert.equal(await receive(bob, 250), null, "self-muted audio is not forwarded");

		alice.send(buildState(VOICE_FLAG.WHISPERING), udp.socket.address().port, "127.0.0.1");
		alice.send(buildAudio(4, 4000, Buffer.from([7, 8, 9])), udp.socket.address().port, "127.0.0.1");
		assert.equal(await receive(bob, 250), null, "bob is outside whisper range");

		alice.send(buildState(0), udp.socket.address().port, "127.0.0.1");
		alice.send(buildAudio(5, 5000, Buffer.from([10, 11])), udp.socket.address().port, "127.0.0.1");
		const response = await receive(bob);
		assert.ok(response, "normal speech is audible again");
		assert.deepEqual([...parseServerAudio(response).payload], [10, 11]);
	} finally {
		await udp.close();
		await closeSocket(alice);
		await closeSocket(bob);
	}
});

test("the relay reports speaking state to the mod", async () => {
	const { state, tokens, udp } = makeEnv();
	const alice = dgram.createSocket("udp4");
	try {
		await bind(alice);
		await udp.listen(0, "127.0.0.1");
		await join(alice, udp, tokens.issue("alice").token);

		alice.send(buildState(VOICE_FLAG.SPEAKING), udp.socket.address().port, "127.0.0.1");
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(state.statusForMod().players.alice.speaking, true);

		alice.send(buildState(0), udp.socket.address().port, "127.0.0.1");
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(state.statusForMod().players.alice.speaking, false);
	} finally {
		await udp.close();
		await closeSocket(alice);
	}
});

test("invalid and reused tokens are rejected", async () => {
	const { tokens, udp } = makeEnv();
	const first = dgram.createSocket("udp4");
	const second = dgram.createSocket("udp4");
	try {
		await bind(first);
		await bind(second);
		await udp.listen(0, "127.0.0.1");

		second.send(buildHello("NOPE00"), udp.socket.address().port, "127.0.0.1");
		const invalid = parseText(await receive(second));
		assert.equal(invalid, "invalid or expired token");

		const token = tokens.issue("alice").token;
		await join(first, udp, token);
		second.send(buildHello(token), udp.socket.address().port, "127.0.0.1");
		const reused = parseText(await receive(second));
		assert.equal(reused, "invalid or expired token");
	} finally {
		await udp.close();
		await closeSocket(first);
		await closeSocket(second);
	}
});

test("a native session is dropped when the game server stops reporting the player", async () => {
	const { state, tokens, udp } = makeEnv();
	const alice = dgram.createSocket("udp4");
	try {
		await bind(alice);
		await udp.listen(0, "127.0.0.1");
		await join(alice, udp, tokens.issue("alice").token);
		assert.ok(state.sessionByName("alice"));

		state.applySync({ players: [] });
		assert.equal(state.sessionByName("alice"), undefined);
	} finally {
		await udp.close();
		await closeSocket(alice);
	}
});

test("native sessions use the same voice range as browser sessions", async () => {
	const { state, tokens, udp } = makeEnv();
	const alice = dgram.createSocket("udp4");
	const bob = dgram.createSocket("udp4");
	try {
		await bind(alice);
		await bind(bob);
		await udp.listen(0, "127.0.0.1");
		const aliceWelcome = await join(alice, udp, tokens.issue("alice").token);
		await join(bob, udp, tokens.issue("bob").token);

		assert.equal(state.sessions.size, 2);
		const aliceSession = [...state.sessions.values()].find((s) => s.name === "alice");
		const bobSession = [...state.sessions.values()].find((s) => s.name === "bob");
		assert.equal(state.canHear(bobSession, aliceSession), true);
		assert.equal(aliceSession.id, state.sessionByName("alice").id);
		assert.ok(aliceWelcome.udpId > 0);
	} finally {
		await udp.close();
		await closeSocket(alice);
		await closeSocket(bob);
	}
});
