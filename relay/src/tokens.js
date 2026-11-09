import crypto from "node:crypto";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function randomCode() {
	const bytes = crypto.randomBytes(CODE_LENGTH);
	let code = "";
	for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
	return code;
}

/**
 * Short-lived, single-use credentials for opening a voice session.
 *
 * Two forms exist for the same grant: a long token embedded in a URL, and a
 * 6-character code that players can read off the in-game panel and type into
 * the voice page. Consuming either form revokes both.
 */
export class TokenStore {
	constructor(ttlMs, { now = Date.now } = {}) {
		this.ttlMs = ttlMs;
		this.now = now;
		this.byToken = new Map();
		this.byCode = new Map();
		this.byName = new Map();
	}

	issue(name) {
		this.revoke(name);

		let code = randomCode();
		while (this.byCode.has(code)) code = randomCode();

		const token = crypto.randomBytes(24).toString("base64url");
		const grant = { name, expires: this.now() + this.ttlMs };
		this.byToken.set(token, grant);
		this.byCode.set(code, grant);
		this.byName.set(name, { token, code });
		return { token, code, expires_in: Math.floor(this.ttlMs / 1000) };
	}

	revoke(name) {
		const existing = this.byName.get(name);
		if (!existing) return;
		this.byToken.delete(existing.token);
		this.byCode.delete(existing.code);
		this.byName.delete(name);
	}

	/** Accepts a long token or a short code. Single use. */
	consume(value) {
		if (typeof value !== "string") return null;
		const normalized = value.trim().toUpperCase();
		const grant = this.byToken.get(value) ?? this.byCode.get(normalized);
		if (!grant) return null;

		// Revoke both forms of the grant, whichever one was presented.
		const issued = this.byName.get(grant.name);
		if (issued) {
			this.byToken.delete(issued.token);
			this.byCode.delete(issued.code);
			this.byName.delete(grant.name);
		} else {
			this.byToken.delete(value);
			this.byCode.delete(normalized);
		}

		if (grant.expires <= this.now()) return null;
		return grant.name;
	}

	prune() {
		const now = this.now();
		for (const [token, grant] of this.byToken) {
			if (grant.expires > now) continue;
			this.byToken.delete(token);
			const issued = this.byName.get(grant.name);
			if (issued && issued.token === token) {
				this.byCode.delete(issued.code);
				this.byName.delete(grant.name);
			}
		}
	}
}
