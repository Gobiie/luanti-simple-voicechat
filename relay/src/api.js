import crypto from "node:crypto";

const MAX_BODY_BYTES = 256 * 1024;

function timingSafeEquals(a, b) {
	const left = Buffer.from(String(a));
	const right = Buffer.from(String(b));
	if (left.length !== right.length) return false;
	return crypto.timingSafeEqual(left, right);
}

function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store",
	});
	res.end(payload);
	return true;
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(Object.assign(new Error("body is not valid JSON"), { statusCode: 400 }));
			}
		});
		req.on("error", reject);
	});
}

/**
 * Authenticated control plane used by the Luanti mod only. Players never talk
 * to these endpoints; they receive single-use tokens instead.
 */
export class Api {
	constructor({ config, state, tokens, log = () => {} }) {
		this.config = config;
		this.state = state;
		this.tokens = tokens;
		this.log = log;
	}

	authorized(req) {
		const header = req.headers.authorization ?? "";
		const match = /^Bearer (.+)$/.exec(header);
		if (!match) return false;
		return timingSafeEquals(match[1], this.config.secret);
	}

	baseUrl(req) {
		if (this.config.public_url) return this.config.public_url.replace(/\/+$/, "");
		const scheme = this.config.tls ? "https" : "http";
		const host = req.headers.host || `localhost:${this.config.port}`;
		return `${scheme}://${host}`;
	}

	async handle(req, res, url) {
		try {
			if (url.pathname === "/health") {
				return sendJson(res, 200, {
					ok: true,
					players: this.state.players.size,
					sessions: this.state.sessions.size,
					groups: this.state.groups.size,
					last_sync_ms_ago: this.state.lastSync ? Date.now() - this.state.lastSync : null,
				});
			}

			if (!url.pathname.startsWith("/api/")) return false;

			if (!this.authorized(req)) {
				sendJson(res, 401, { error: "missing or invalid relay secret" });
				return true;
			}
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "use POST" });
				return true;
			}

			const body = await readJsonBody(req);

			switch (url.pathname) {
				case "/api/v1/token":
					return this.issueToken(req, res, body);
				case "/api/v1/sync":
					return this.sync(req, res, body);
				case "/api/v1/admin/mute":
					return this.adminMute(req, res, body);
				case "/api/v1/admin/kick":
					return this.adminKick(req, res, body);
				case "/api/v1/admin/groups":
					sendJson(res, 200, { groups: this.state.listGroups() });
					return true;
				case "/api/v1/admin/invite":
					return this.adminInvite(req, res, body);
				default:
					sendJson(res, 404, { error: "unknown endpoint" });
					return true;
			}
		} catch (err) {
			const status = err.statusCode ?? 500;
			if (status >= 500) this.log("error", `${req.method} ${url.pathname}: ${err.stack ?? err.message}`);
			sendJson(res, status, { error: err.message });
			return true;
		}
	}

	issueToken(req, res, body) {
		const player = typeof body.player === "string" ? body.player.trim() : "";
		if (!player || player.length > 64) {
			return sendJson(res, 400, { error: "`player` must be a player name" });
		}
		if (this.config.require_known_player && !this.state.players.has(player)) {
			return sendJson(res, 409, { error: "that player is not in the game" });
		}
		const { token, code, expires_in } = this.tokens.issue(player);
		sendJson(res, 200, {
			token,
			code,
			expires_in,
			url: `${this.baseUrl(req)}/?t=${encodeURIComponent(token)}`,
		});
		return true;
	}

	sync(req, res, body) {
		this.state.applySync(body);
		sendJson(res, 200, this.state.statusForMod());
		this.state.broadcast(this.state.positionsPayload());
		return true;
	}

	adminMute(req, res, body) {
		const player = typeof body.player === "string" ? body.player.trim() : "";
		if (!player) return sendJson(res, 400, { error: "`player` is required" });
		if (!this.state.setAdminMute(player, body.muted !== false)) {
			return sendJson(res, 404, { error: "unknown player" });
		}
		sendJson(res, 200, { ok: true });
		return true;
	}

	adminInvite(req, res, body) {
		const from = typeof body.from === "string" ? body.from.trim() : "";
		const player = typeof body.player === "string" ? body.player.trim() : "";
		if (!from) return sendJson(res, 400, { error: "`from` is required" });
		if (!player) return sendJson(res, 400, { error: "`player` is required" });
		const result = this.state.inviteToGroup(from, player);
		if (!result.ok) return sendJson(res, 409, { error: result.error });
		sendJson(res, 200, { ok: true, group: result.group });
		return true;
	}

	adminKick(req, res, body) {
		const player = typeof body.player === "string" ? body.player.trim() : "";
		if (!player) return sendJson(res, 400, { error: "`player` is required" });
		if (!this.state.kickPlayer(player, body.reason ? String(body.reason) : undefined)) {
			return sendJson(res, 404, { error: "that player is not on voice chat" });
		}
		sendJson(res, 200, { ok: true });
		return true;
	}
}
