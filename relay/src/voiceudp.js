import dgram from "node:dgram";

/**
 * Native voice transport for the Luanti client fork.
 *
 * The browser panel uses WebRTC; the in-game client uses this small UDP
 * protocol. Audio is still Opus and the relay never decodes it: it only decides
 * who may hear whom (VoiceState) and forwards the packets.
 *
 * Wire format (all integers little-endian):
 *
 *   header: magic "SVL1" (4) | type (1) | flags (1) | reserved (2)
 *
 *   HELLO   client -> relay: header | string token
 *   WELCOME relay -> client: header | u32 udp_id | string player_name
 *   AUDIO   client -> relay: header | u32 sequence | u32 timestamp | payload
 *   AUDIO   relay -> client: header | u32 sender_id | u32 sequence |
 *                            u32 timestamp | f32 x | f32 y | f32 z |
 *                            string sender_name | payload
 *   STATE   client -> relay: header | u8 flags
 *   NOTICE  relay -> client: header | string message
 *   ERROR   relay -> client: header | string message
 *   BYE     relay -> client: header | string reason
 *   PING    client -> relay: header
 *
 * Flags: 1 = self muted, 2 = whispering, 4 = broadcasting, 8 = speaking.
 */

export const VOICE_MAGIC = Buffer.from("SVL1");
export const VOICE_PACKET = Object.freeze({
	HELLO: 1,
	WELCOME: 2,
	AUDIO: 3,
	STATE: 4,
	NOTICE: 5,
	BYE: 6,
	PING: 7,
	ERROR: 8,
});

const HEADER_SIZE = 8;
const MAX_PACKET = 1200;
const MAX_PAYLOAD = 1000;
const SESSION_TIMEOUT_MS = 30_000;
const SWEEP_INTERVAL_MS = 5_000;

export const VOICE_FLAG = Object.freeze({
	SELF_MUTED: 1,
	WHISPERING: 2,
	BROADCASTING: 4,
	SPEAKING: 8,
});

function header(type, flags = 0) {
	const out = Buffer.alloc(HEADER_SIZE);
	VOICE_MAGIC.copy(out, 0);
	out[4] = type;
	out[5] = flags & 0xff;
	return out;
}

function withString(prefix, value) {
	const encoded = Buffer.from(String(value), "utf8");
	const length = Math.min(encoded.length, 65_535);
	const out = Buffer.alloc(2 + length);
	out.writeUInt16LE(length, 0);
	encoded.copy(out, 2, 0, length);
	return Buffer.concat([prefix, out]);
}

function readString(buffer, offset) {
	if (offset + 2 > buffer.length) return null;
	const length = buffer.readUInt16LE(offset);
	offset += 2;
	if (offset + length > buffer.length) return null;
	return { value: buffer.toString("utf8", offset, offset + length), offset: offset + length };
}

function hasMagic(buffer) {
	return buffer.length >= HEADER_SIZE && buffer.subarray(0, 4).equals(VOICE_MAGIC);
}

export function buildHello(token) {
	return withString(header(VOICE_PACKET.HELLO), token);
}

export function buildAudio(sequence, timestamp, payload) {
	const body = Buffer.from(payload);
	const out = Buffer.alloc(HEADER_SIZE + 8 + body.length);
	header(VOICE_PACKET.AUDIO).copy(out, 0);
	out.writeUInt32LE(sequence >>> 0, HEADER_SIZE);
	out.writeUInt32LE(timestamp >>> 0, HEADER_SIZE + 4);
	body.copy(out, HEADER_SIZE + 8);
	return out;
}

export function buildState(flags) {
	return header(VOICE_PACKET.STATE, flags);
}

export function buildPing() {
	return header(VOICE_PACKET.PING);
}

export function buildWelcome(udpId, name) {
	const base = Buffer.alloc(HEADER_SIZE + 4);
	header(VOICE_PACKET.WELCOME).copy(base, 0);
	base.writeUInt32LE(udpId >>> 0, HEADER_SIZE);
	return withString(base, name);
}

export function buildServerAudio(senderId, sequence, timestamp, position, senderName, payload) {
	const body = Buffer.from(payload);
	const base = Buffer.alloc(HEADER_SIZE + 4 + 4 + 4 + 12);
	header(VOICE_PACKET.AUDIO).copy(base, 0);
	base.writeUInt32LE(senderId >>> 0, HEADER_SIZE);
	base.writeUInt32LE(sequence >>> 0, HEADER_SIZE + 4);
	base.writeUInt32LE(timestamp >>> 0, HEADER_SIZE + 8);
	base.writeFloatLE(Number(position?.[0]) || 0, HEADER_SIZE + 12);
	base.writeFloatLE(Number(position?.[1]) || 0, HEADER_SIZE + 16);
	base.writeFloatLE(Number(position?.[2]) || 0, HEADER_SIZE + 20);
	return Buffer.concat([withString(base, senderName), body]);
}

export function parseWelcome(buffer) {
	if (!hasMagic(buffer) || buffer[4] !== VOICE_PACKET.WELCOME || buffer.length < HEADER_SIZE + 4)
		return null;
	const name = readString(buffer, HEADER_SIZE + 4);
	if (!name) return null;
	return { udpId: buffer.readUInt32LE(HEADER_SIZE), name: name.value };
}

export function parseAudio(buffer) {
	if (!hasMagic(buffer) || buffer[4] !== VOICE_PACKET.AUDIO || buffer.length < HEADER_SIZE + 8)
		return null;
	const payload = buffer.subarray(HEADER_SIZE + 8);
	if (payload.length === 0 || payload.length > MAX_PAYLOAD) return null;
	return {
		sequence: buffer.readUInt32LE(HEADER_SIZE),
		timestamp: buffer.readUInt32LE(HEADER_SIZE + 4),
		payload,
	};
}

export function parseServerAudio(buffer) {
	if (!hasMagic(buffer) || buffer[4] !== VOICE_PACKET.AUDIO || buffer.length < HEADER_SIZE + 24)
		return null;
	const senderId = buffer.readUInt32LE(HEADER_SIZE);
	const sequence = buffer.readUInt32LE(HEADER_SIZE + 4);
	const timestamp = buffer.readUInt32LE(HEADER_SIZE + 8);
	const position = [
		buffer.readFloatLE(HEADER_SIZE + 12),
		buffer.readFloatLE(HEADER_SIZE + 16),
		buffer.readFloatLE(HEADER_SIZE + 20),
	];
	const name = readString(buffer, HEADER_SIZE + 24);
	if (!name) return null;
	const payload = buffer.subarray(name.offset);
	if (payload.length === 0 || payload.length > MAX_PAYLOAD) return null;
	return { senderId, sequence, timestamp, position, senderName: name.value, payload };
}

export function parseText(buffer) {
	if (!hasMagic(buffer)) return null;
	const text = readString(buffer, HEADER_SIZE);
	return text ? text.value : null;
}

/**
 * @param {object} opts
 * @param {object} opts.config
 * @param {import("./voice.js").VoiceState} opts.state
 * @param {import("./tokens.js").TokenStore} opts.tokens
 * @param {(level: string, message: string) => void} [opts.log]
 * @param {() => number} [opts.now]
 */
export function createVoiceUdpServer({ config, state, tokens, log = () => {}, now = Date.now }) {
	const socket = dgram.createSocket("udp4");
	const byAddress = new Map();
	const byId = new Map();
	let nextId = 1;
	let sweepTimer = null;
	let closed = false;

	const addressKey = (rinfo) => `${rinfo.address}:${rinfo.port}`;

	function send(session, packet) {
		if (closed || !session.address) return;
		socket.send(packet, session.address.port, session.address.address, (err) => {
			if (err) log("warn", `voice udp send to ${session.name} failed: ${err.message}`);
		});
	}

	function sendError(address, message) {
		if (closed) return;
		const packet = withString(header(VOICE_PACKET.ERROR), String(message).slice(0, 500));
		socket.send(packet, address.port, address.address, () => {});
	}

	function sendNotice(session, message) {
		send(session, withString(header(VOICE_PACKET.NOTICE), String(message).slice(0, 500)));
	}

	function dropSession(session, reason = "disconnected") {
		if (!session || !byId.has(session.id)) return;
		byId.delete(session.id);
		const key = addressKey(session.address);
		if (byAddress.get(key) === session) byAddress.delete(key);
		send(session, withString(header(VOICE_PACKET.BYE), reason));
		// This calls transport.close() again, which is a no-op because the maps
		// no longer contain the session.
		if (session.vsession) state.dropSession(session.vsession, reason);
		log("info", `${session.name} left native voice: ${reason}`);
	}

	function handleHello(buffer, rinfo) {
		const token = readString(buffer, HEADER_SIZE);
		if (!token || !token.value) {
			sendError(rinfo, "missing token");
			return;
		}

		const name = tokens.consume(token.value);
		if (!name) {
			sendError(rinfo, "invalid or expired token");
			return;
		}
		const player = state.players.get(name);
		if (!player) {
			sendError(rinfo, "player is not in the game");
			return;
		}
		if (player.voice === false) {
			sendError(rinfo, "voice chat is disabled for this player");
			return;
		}

		const existing = byAddress.get(addressKey(rinfo));
		if (existing) dropSession(existing, "replaced by a new session");

		const session = {
			id: nextId++ >>> 0,
			name,
			address: { address: rinfo.address, port: rinfo.port },
			lastSeen: now(),
			vsession: null,
		};

		const transport = {
			send: (message) => {
				if (!message || typeof message !== "object") return;
				if (message.type === "notice") sendNotice(session, message.message);
				else if (message.type === "admin_mute")
					sendNotice(session, message.muted ? "An admin muted you." : "An admin unmuted you.");
				else if (message.type === "group")
					sendNotice(session, message.group ? `Group: ${message.group.name}` : "You left the group.");
				// WebRTC-specific connect/link messages do not exist natively.
			},
			close: (code, reason) => dropSession(session, reason || "closed"),
		};

		session.vsession = state.openSession(name, transport);
		byId.set(session.id, session);
		byAddress.set(addressKey(session.address), session);
		send(session, buildWelcome(session.id, name));
		state.recompute();
		log("info", `${name} joined native voice from ${session.address.address}:${session.address.port}`);
	}

	function handleAudio(buffer, session) {
		if (!session.vsession) return;
		const audio = parseAudio(buffer);
		if (!audio) return;
		const player = state.players.get(session.name);
		if (!player) return;
		if (session.vsession.self_muted || player.admin_muted) return;

		// `canHear` uses the authoritative positions/groups and checks both the
		// listener's and the speaker's state.
		for (const other of byId.values()) {
			if (other.id === session.id || !other.vsession) continue;
			if (!state.canHear(other.vsession, session.vsession)) continue;
			send(
				other,
				buildServerAudio(
					session.id,
					audio.sequence,
					audio.timestamp,
					player.pos,
					session.name,
					audio.payload
				)
			);
		}
	}

	function handleState(buffer, session) {
		if (!session.vsession) return;
		const flags = buffer[5];
		session.vsession.self_muted = Boolean(flags & VOICE_FLAG.SELF_MUTED);
		session.vsession.whispering = Boolean(flags & VOICE_FLAG.WHISPERING);
		session.vsession.broadcasting = Boolean(flags & VOICE_FLAG.BROADCASTING);
		session.vsession.speaking = Boolean(flags & VOICE_FLAG.SPEAKING);
		state.recompute();
	}

	socket.on("message", (buffer, rinfo) => {
		if (closed || buffer.length > MAX_PACKET || !hasMagic(buffer)) return;
		const type = buffer[4];
		if (type === VOICE_PACKET.HELLO) {
			handleHello(buffer, rinfo);
			return;
		}

		const session = byAddress.get(addressKey(rinfo));
		if (!session) return;
		session.lastSeen = now();
		if (type === VOICE_PACKET.AUDIO) handleAudio(buffer, session);
		else if (type === VOICE_PACKET.STATE) handleState(buffer, session);
		else if (type === VOICE_PACKET.BYE) dropSession(session, "client left");
		// PING only refreshes lastSeen.
	});

	socket.on("error", (err) => log("error", `voice udp socket: ${err.message}`));

	function listen(port = config.voice_udp_port, host = config.voice_udp_host ?? "0.0.0.0") {
		return new Promise((resolve, reject) => {
			const onError = (err) => {
				socket.removeListener("listening", onListening);
				reject(err);
			};
			const onListening = () => {
				socket.removeListener("error", onError);
				const address = socket.address();
				sweepTimer = setInterval(() => {
					const cutoff = now() - SESSION_TIMEOUT_MS;
					for (const session of [...byId.values()]) {
						if (session.lastSeen < cutoff) dropSession(session, "voice timeout");
					}
				}, SWEEP_INTERVAL_MS);
				sweepTimer.unref?.();
				log("info", `native voice UDP listening on ${address.address}:${address.port}`);
				resolve(address);
			};
			socket.once("error", onError);
			socket.once("listening", onListening);
			socket.bind(port, host);
		});
	}

	async function close() {
		if (closed) return;
		closed = true;
		if (sweepTimer) clearInterval(sweepTimer);
		for (const session of [...byId.values()]) dropSession(session, "server shutting down");
		try {
			await new Promise((resolve) => socket.close(() => resolve()));
		} catch {
			// Binding may have failed; there is nothing left to close.
		}
	}

	return { socket, listen, close, byId, byAddress, addressKey };
}
