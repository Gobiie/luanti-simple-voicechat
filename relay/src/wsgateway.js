import { WebSocketServer } from "ws";

const AUTH_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 128 * 1024;
const RATE_WINDOW_MS = 1000;
const RATE_LIMIT = 200;

function parseMessage(raw) {
	if (raw.length > MAX_MESSAGE_BYTES) return null;
	try {
		const value = JSON.parse(raw.toString("utf8"));
		return value && typeof value === "object" && typeof value.type === "string" ? value : null;
	} catch {
		return null;
	}
}

/**
 * WebSocket gateway. Players connect with a single-use token, then exchange
 * WebRTC offers/answers/candidates through this socket. Audio never touches the
 * relay: it flows peer to peer over DTLS-SRTP.
 */
export function attachGateway({ server, config, state, tokens, log = () => {} }) {
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

	server.on("upgrade", (req, socket, head) => {
		let pathname;
		try {
			pathname = new URL(req.url, "http://localhost").pathname;
		} catch {
			socket.destroy();
			return;
		}
		if (pathname !== "/ws") {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
	});

	wss.on("connection", (ws) => {
		let session = null;
		let rateWindow = { started: Date.now(), count: 0 };
		const send = (message) => {
			if (ws.readyState !== ws.OPEN) return;
			try {
				ws.send(JSON.stringify(message));
			} catch (err) {
				log("warn", `websocket send failed: ${err.message}`);
			}
		};

		const authTimer = setTimeout(() => {
			if (!session) ws.close(4003, "authentication timeout");
		}, AUTH_TIMEOUT_MS);

		const fail = (message) => {
			send({ type: "error", message });
		};

		ws.on("message", (raw) => {
			const now = Date.now();
			if (now - rateWindow.started > RATE_WINDOW_MS) rateWindow = { started: now, count: 0 };
			if (++rateWindow.count > RATE_LIMIT) {
				send({ type: "error", message: "too many messages" });
				return;
			}

			const message = parseMessage(raw);
			if (!message) {
				fail("malformed message");
				return;
			}

			if (message.type === "auth") {
				if (session) {
					fail("already authenticated");
					return;
				}
				if (typeof message.token !== "string") {
					ws.close(4003, "missing token");
					return;
				}
				const name = tokens.consume(message.token);
				if (!name) {
					ws.close(4003, "invalid or expired token");
					return;
				}
				if (config.require_known_player && !state.players.has(name)) {
					ws.close(4003, "player is not in the game");
					return;
				}
				clearTimeout(authTimer);
				session = state.openSession(name, {
					send: (obj) => send(obj),
					close: (code, reason) => ws.close(code, reason),
				});
				send({
					type: "welcome",
					you: { id: session.id, name: session.name },
					config: {
						max_voice_distance: config.max_voice_distance,
						whisper_distance: config.whisper_distance,
						broadcast_range: config.broadcast_range,
						allow_recording: config.allow_recording,
						groups_enabled: config.groups_enabled,
						ice_servers: config.ice_servers,
						invert_pan: config.invert_pan,
					},
				});
				state.recompute();
				state.broadcast(state.positionsPayload());
				log("info", `${name} joined voice chat (session ${session.id})`);
				return;
			}

			if (!session) {
				ws.close(4003, "authenticate first");
				return;
			}

			switch (message.type) {
				case "group.join": {
					if (typeof message.name !== "string") {
						fail("`name` is required");
						return;
					}
					const result = state.joinGroup(session, message.name, message.password, message.groupType);
					if (!result.ok) fail(result.error);
					return;
				}
				case "group.leave":
					state.leaveGroup(session);
					return;
				case "group.invite": {
					if (typeof message.player !== "string") {
						fail("`player` is required");
						return;
					}
					const invited = message.player.trim();
					const result = state.inviteToGroup(session.name, invited);
					if (!result.ok) fail(result.error);
					else send({ type: "notice", message: `Invited ${invited} to the group.` });
					return;
				}
				case "self_mute":
					session.self_muted = Boolean(message.muted);
					send({ type: "self_mute", muted: session.self_muted });
					state.recompute();
					return;
				case "whisper":
					session.whispering = Boolean(message.on);
					state.recompute();
					return;
				case "broadcast":
					session.broadcasting = Boolean(message.on);
					send({ type: "broadcast", on: session.broadcasting });
					state.recompute();
					return;
				case "speaking": {
					const speaking = Boolean(message.on);
					if (speaking === session.speaking) return;
					session.speaking = speaking;
					state.broadcast({ type: "speaking", id: session.id, on: speaking });
					return;
				}
				case "signal": {
					const target = state.sessions.get(message.to);
					if (!target || !state.areLinked(session, target)) {
						fail("not connected to that player");
						return;
					}
					target.send({ type: "signal", from: session.id, data: message.data });
					return;
				}
				case "ping":
					send({ type: "pong", t: message.t ?? null });
					return;
				default:
					fail(`unknown message type: ${message.type}`);
			}
		});

		ws.on("close", () => {
			clearTimeout(authTimer);
			if (session) state.dropSession(session, "disconnected");
		});

		ws.on("error", (err) => {
			log("warn", `websocket error: ${err.message}`);
		});
	});

	return wss;
}
