import crypto from "node:crypto";

const GROUP_NAME_RE = /^[A-Za-z0-9_ -]{1,24}$/;
const MAX_PASSWORD_LEN = 64;
const GROUP_TYPES = new Set(["normal", "open", "isolated"]);

export function distance(a, b) {
	const dx = a[0] - b[0];
	const dy = a[1] - b[1];
	const dz = a[2] - b[2];
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function pairKey(a, b) {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function peerRef(session) {
	return { id: session.id, name: session.name };
}

function hashPassword(password, salt) {
	return crypto.scryptSync(password, salt, 32).toString("hex");
}

function passwordMatches(password, group) {
	if (!group.password_hash) return true;
	const candidate = Buffer.from(hashPassword(String(password ?? ""), group.salt), "hex");
	const expected = Buffer.from(group.password_hash, "hex");
	return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/**
 * Authoritative voice routing state.
 *
 * The Luanti mod pushes player positions over the authenticated HTTP API; the
 * gateway pushes websocket sessions in. Everything about who may hear whom is
 * decided here, exactly like Simple Voice Chat's voice server decides routing
 * while the clients only render the audio.
 *
 * Links are bidirectional transports with a per-side `hear` flag, because
 * whispering is directional: if Bob whispers, Alice only hears Bob within the
 * whisper distance, but Alice's normal-range voice still reaches Bob.
 */
export class VoiceState {
	constructor(config, { now = Date.now, log = () => {} } = {}) {
		this.config = config;
		this.now = now;
		this.log = log;
		this.players = new Map(); // name -> snapshot from the mod
		this.sessions = new Map(); // session id -> session
		this.byName = new Map(); // player name -> session id
		this.groups = new Map(); // lowercase name -> group
		this.links = new Map(); // pair key -> { x, y, xHearsY, yHearsX }
		this.lastSync = 0;
	}

	// ---------------------------------------------------------------- players

	/**
	 * Replace the player snapshot. Called at the mod's sync rate (default 4 Hz).
	 * `players` is the complete list of players currently in the Luanti game.
	 */
	applySync(payload) {
		const now = this.now();
		this.lastSync = now;
		const seen = new Set();

		for (const raw of Array.isArray(payload?.players) ? payload.players : []) {
			const name = typeof raw?.name === "string" ? raw.name.trim() : "";
			if (!name || name.length > 64) continue;
			seen.add(name);
			const previous = this.players.get(name);
			const pos =
				Array.isArray(raw.pos) && raw.pos.length === 3 ? raw.pos.map((n) => Number(n) || 0) : previous?.pos ?? [0, 0, 0];
			this.players.set(name, {
				name,
				pos,
				yaw: Number(raw.yaw) || 0,
				voice: raw.voice !== false,
				admin_muted: previous?.admin_muted ?? false,
				last_seen: now,
			});
		}

		for (const name of [...this.players.keys()]) {
			if (seen.has(name)) continue;
			this.players.delete(name);
			const session = this.sessionByName(name);
			if (session) this.dropSession(session, "left the game");
		}

		for (const session of [...this.sessions.values()]) {
			const player = this.players.get(session.name);
			if (!player || !player.voice) this.dropSession(session, "voice chat disabled");
		}

		this.recompute();
	}

	/** Drops every session if the game server stopped talking to us. */
	checkStale() {
		if (this.sessions.size === 0 || this.lastSync === 0) return;
		if (this.now() - this.lastSync <= this.config.sync_timeout * 1000) return;
		this.log("warn", "no state update from the Luanti server, dropping voice sessions");
		for (const session of [...this.sessions.values()]) {
			this.dropSession(session, "lost connection to the game server");
		}
	}

	playerOf(session) {
		return session ? this.players.get(session.name) : undefined;
	}

	// --------------------------------------------------------------- sessions

	sessionByName(name) {
		const id = this.byName.get(name);
		return id ? this.sessions.get(id) : undefined;
	}

	/**
	 * Registers a session. Does not recompute links: the caller sends the
	 * welcome message first and then calls recompute().
	 */
	openSession(name, transport) {
		const existing = this.sessionByName(name);
		if (existing) this.dropSession(existing, "signed in from another tab");

		const session = {
			id: crypto.randomBytes(8).toString("hex"),
			name,
			group: null,
			whispering: false,
			broadcasting: false,
			self_muted: false,
			speaking: false,
			admin_muted: false,
			created: this.now(),
			send: (message) => {
				try {
					transport.send(message);
				} catch (err) {
					this.log("warn", `send to ${name} failed: ${err.message}`);
				}
			},
			close: (code, reason) => {
				try {
					transport.close(code, reason);
				} catch {
					/* socket already gone */
				}
			},
		};
		this.sessions.set(session.id, session);
		this.byName.set(name, session.id);
		return session;
	}

	dropSession(session, reason = "disconnected", code = 4001) {
		if (!this.sessions.has(session.id)) return;
		this.sessions.delete(session.id);
		if (this.byName.get(session.name) === session.id) this.byName.delete(session.name);

		// Remove the session from its group without notifying a dead socket.
		const group = session.group ? this.groups.get(session.group) : null;
		session.group = null;
		if (group) {
			group.members.delete(session.id);
			if (group.members.size === 0) this.groups.delete(group.key);
			else this.broadcastGroup(group);
		}

		this.links.delete(pairKey(session.id, session.id));
		for (const [key, link] of this.links) {
			if (link.x.id !== session.id && link.y.id !== session.id) continue;
			const other = link.x.id === session.id ? link.y : link.x;
			other.send({ type: "disconnect", peer: peerRef(session) });
			this.links.delete(key);
		}

		for (const other of this.sessions.values()) {
			other.send({ type: "peer.left", peer: peerRef(session) });
		}

		session.close(code, reason);
		this.log("info", `${session.name} left voice chat: ${reason}`);
		this.recompute();
	}

	// ----------------------------------------------------------------- groups

	groupInfo(group) {
		const members = [];
		for (const id of group.members) {
			const session = this.sessions.get(id);
			if (session) members.push(session.name);
		}
		members.sort((a, b) => a.localeCompare(b));
		return { name: group.name, type: group.type, members, locked: Boolean(group.password_hash) };
	}

	broadcastGroup(group) {
		const info = this.groupInfo(group);
		for (const id of group.members) {
			this.sessions.get(id)?.send({ type: "group", group: info });
		}
	}

	joinGroup(session, name, password, type) {
		if (!this.config.groups_enabled) return { ok: false, error: "group chats are disabled on this server" };

		name = typeof name === "string" ? name.trim() : "";
		if (!GROUP_NAME_RE.test(name)) {
			return { ok: false, error: "group names may only contain letters, numbers, spaces, _ and - (max 24)" };
		}
		if (typeof password === "string" && password.length > MAX_PASSWORD_LEN) {
			return { ok: false, error: "group password is too long" };
		}

		const key = name.toLowerCase();
		let group = this.groups.get(key);
		if (group) {
			if (!passwordMatches(password, group)) return { ok: false, error: "wrong group password" };
			if (!group.members.has(session.id) && group.members.size >= this.config.max_group_members) {
				return { ok: false, error: "that group is full" };
			}
		} else {
			const groupType = GROUP_TYPES.has(type) ? type : "normal";
			const salt = crypto.randomBytes(16).toString("hex");
			group = {
				name,
				key,
				type: groupType,
				salt,
				// Open groups can be joined by anyone, so a password would be a lie.
				password_hash: groupType !== "open" && password ? hashPassword(password, salt) : null,
				members: new Set(),
			};
			this.groups.set(key, group);
		}

		this.leaveGroup(session, { silent: true });
		session.group = key;
		group.members.add(session.id);
		this.broadcastGroup(group);
		this.recompute();
		return { ok: true, group: this.groupInfo(group) };
	}

	leaveGroup(session, { silent = false } = {}) {
		const group = session.group ? this.groups.get(session.group) : null;
		session.group = null;
		if (group) {
			group.members.delete(session.id);
			if (group.members.size === 0) this.groups.delete(group.key);
			else this.broadcastGroup(group);
		}
		if (!silent) {
			session.send({ type: "group", group: null });
			this.recompute();
		}
	}

	/**
	 * Adds a player to the inviter's group without the password, the way
	 * `/voicechat invite <player>` works in Simple Voice Chat.
	 */
	inviteToGroup(inviterName, targetName) {
		const inviter = this.sessionByName(inviterName);
		if (!inviter || !inviter.group) return { ok: false, error: "you are not in a group" };
		const target = this.sessionByName(targetName);
		if (!target) return { ok: false, error: "that player is not on voice chat" };
		const group = this.groups.get(inviter.group);
		if (!group) return { ok: false, error: "that group no longer exists" };
		if (target.group === group.key) return { ok: true, group: this.groupInfo(group), already: true };
		if (group.members.size >= this.config.max_group_members) return { ok: false, error: "that group is full" };

		this.leaveGroup(target, { silent: true });
		target.group = group.key;
		group.members.add(target.id);
		this.broadcastGroup(group);
		target.send({ type: "notice", message: `You were added to the group ${group.name}.` });
		this.recompute();
		return { ok: true, group: this.groupInfo(group) };
	}

	// -------------------------------------------------------------- moderation

	setAdminMute(name, muted) {
		const player = this.players.get(name);
		if (!player) return false;
		player.admin_muted = Boolean(muted);
		const session = this.sessionByName(name);
		if (session) {
			session.admin_muted = player.admin_muted;
			session.send({ type: "admin_mute", muted: player.admin_muted });
		}
		this.recompute();
		return true;
	}

	kickPlayer(name, reason = "removed by a server admin") {
		const session = this.sessionByName(name);
		if (!session) return false;
		this.dropSession(session, reason, 4001);
		return true;
	}

	// ----------------------------------------------------------------- routing

	canHear(listener, speaker) {
		if (!listener || !speaker || listener.id === speaker.id) return false;

		const listenerPlayer = this.playerOf(listener);
		const speakerPlayer = this.playerOf(speaker);
		if (!listenerPlayer || !speakerPlayer) return false;
		if (listenerPlayer.voice === false || speakerPlayer.voice === false) return false;
		if (speaker.self_muted || speakerPlayer.admin_muted) return false;

		const separation = distance(listenerPlayer.pos, speakerPlayer.pos);

		// Broadcast reaches everyone inside the broadcast range and ignores
		// groups. It only widens the speaker's outgoing radius.
		if (speaker.broadcasting && this.config.broadcast_range > 0) {
			return separation <= this.config.broadcast_range;
		}

		// Group audio ignores distance; what crosses the group boundary depends on
		// the group type, exactly like Simple Voice Chat:
		//   normal   - members hear nearby players, but not the other way round
		//   open     - proximity is audible in both directions
		//   isolated - nothing crosses the group boundary
		const listenerGroup = listener.group ? this.groups.get(listener.group) : null;
		const speakerGroup = speaker.group ? this.groups.get(speaker.group) : null;
		if (listenerGroup && speakerGroup && listenerGroup.key === speakerGroup.key) return true;
		if (speakerGroup && speakerGroup.type !== "open") return false;
		if (listenerGroup && listenerGroup.type === "isolated") return false;
		if (listenerGroup && speakerGroup) return false;

		const range = speaker.whispering ? this.config.whisper_distance : this.config.max_voice_distance;
		return separation <= range;
	}

	recompute() {
		const sessions = [...this.sessions.values()];
		const desired = new Map();

		for (let i = 0; i < sessions.length; i++) {
			for (let j = i + 1; j < sessions.length; j++) {
				const a = sessions[i];
				const b = sessions[j];
				const aHearsB = this.canHear(a, b);
				const bHearsA = this.canHear(b, a);
				if (!aHearsB && !bHearsA) continue;

				const [x, y] = a.id < b.id ? [a, b] : [b, a];
				desired.set(pairKey(x.id, y.id), {
					x,
					y,
					xHearsY: x === a ? aHearsB : bHearsA,
					yHearsX: x === a ? bHearsA : aHearsB,
				});
			}
		}

		for (const [key, link] of this.links) {
			if (desired.has(key)) continue;
			link.x.send({ type: "disconnect", peer: peerRef(link.y) });
			link.y.send({ type: "disconnect", peer: peerRef(link.x) });
			this.links.delete(key);
		}

		for (const [key, want] of desired) {
			const have = this.links.get(key);
			if (!have) {
				// Deterministic initiator keeps both sides from offering at once.
				want.x.send({ type: "connect", peer: peerRef(want.y), initiator: true });
				want.y.send({ type: "connect", peer: peerRef(want.x), initiator: false });
				want.x.send({ type: "link", peer: peerRef(want.y), hear: want.xHearsY });
				want.y.send({ type: "link", peer: peerRef(want.x), hear: want.yHearsX });
				this.links.set(key, { ...want });
				continue;
			}
			if (have.xHearsY === want.xHearsY && have.yHearsX === want.yHearsX) continue;
			have.xHearsY = want.xHearsY;
			have.yHearsX = want.yHearsX;
			have.x.send({ type: "link", peer: peerRef(have.y), hear: have.xHearsY });
			have.y.send({ type: "link", peer: peerRef(have.x), hear: have.yHearsX });
		}
	}

	listGroups() {
		return [...this.groups.values()].map((group) => this.groupInfo(group));
	}

	areLinked(sessionA, sessionB) {
		return this.links.has(pairKey(sessionA.id, sessionB.id));
	}

	// --------------------------------------------------------------- reporting

	/** Snapshot for the mod: what the game server needs to show in-game. */
	statusForMod() {
		const players = {};
		for (const [name, player] of this.players) {
			const session = this.sessionByName(name);
			const group = session?.group ? this.groups.get(session.group) : null;
			players[name] = {
				connected: Boolean(session),
				group: group ? group.name : null,
				admin_muted: Boolean(player.admin_muted),
				speaking: Boolean(session?.speaking),
				broadcasting: Boolean(session?.broadcasting),
			};
		}
		return {
			ok: true,
			players,
			max_voice_distance: this.config.max_voice_distance,
			whisper_distance: this.config.whisper_distance,
			broadcast_range: this.config.broadcast_range,
			allow_recording: this.config.allow_recording,
		};
	}

	/** Positions + flags, broadcast to every voice client at sync rate. */
	positionsPayload() {
		const players = [];
		for (const session of this.sessions.values()) {
			const player = this.playerOf(session);
			if (!player) continue;
			const group = session.group ? this.groups.get(session.group) : null;
			players.push({
				id: session.id,
				name: session.name,
				pos: player.pos,
				yaw: player.yaw,
				group: group ? group.name : null,
				speaking: session.speaking,
				self_muted: session.self_muted,
				whispering: session.whispering,
				broadcasting: session.broadcasting,
			});
		}
		return { type: "positions", players };
	}

	broadcast(message) {
		for (const session of this.sessions.values()) session.send(message);
	}
}
