import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELAY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULTS = {
	host: "0.0.0.0",
	port: 8090,
	// UDP port for the native Luanti client's voice transport. The browser
	// panel uses WebRTC and does not use this port.
	voice_udp_host: "0.0.0.0",
	voice_udp_port: 8091,
	// Shared secret. Must match `simple_voicechat.secret` in minetest.conf.
	secret: "",
	// All distances are in Luanti nodes (1 node = 1 metre).
	max_voice_distance: 32,
	whisper_distance: 8,
	// 0 disables the broadcast key (same default as Simple Voice Chat).
	broadcast_range: 0,
	allow_recording: true,
	groups_enabled: true,
	max_group_members: 20,
	// If the Luanti server stops sending state updates for this long, every
	// voice session is dropped instead of leaving ghost audio routing behind.
	sync_timeout: 15,
	token_ttl: 120,
	require_known_player: true,
	// Optional public base URL used for links shown in game, e.g.
	// "https://voice.example.com". Empty means "derive from the request Host".
	public_url: "",
	// Empty by default: direct host candidates work on a LAN or a public host.
	// Internet players behind symmetric NAT need a TURN server (e.g. coturn).
	ice_servers: [],
	// Flip if left/right panning is mirrored. Luanti yaw convention is
	// documented in docs/PROTOCOL.md.
	invert_pan: false,
	// {"cert": "/path/fullchain.pem", "key": "/path/privkey.pem"}
	// Required for players not on localhost: browsers only allow microphone
	// access in a secure context (HTTPS).
	tls: null,
	public_dir: path.join(RELAY_ROOT, "public"),
};

export class ConfigError extends Error {}

function readJson(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		throw new ConfigError(`cannot read config file ${file}: ${err.message}`);
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new ConfigError(`config file ${file} is not valid JSON: ${err.message}`);
	}
}

function resolveMaybe(baseDir, value) {
	if (typeof value !== "string" || value === "") return value;
	return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

export function loadConfig({ file, env = process.env, argv = process.argv.slice(2) } = {}) {
	// `--config path/to/config.json`
	const flagIndex = argv.indexOf("--config");
	if (!file && flagIndex !== -1) file = argv[flagIndex + 1];

	const baseDir = file ? path.dirname(path.resolve(file)) : RELAY_ROOT;
	const cfg = { ...DEFAULTS, ...(file ? readJson(file) : {}) };

	if (env.SVC_HOST) cfg.host = env.SVC_HOST;
	if (env.SVC_PORT) cfg.port = Number(env.SVC_PORT);
	if (env.SVC_VOICE_UDP_HOST) cfg.voice_udp_host = env.SVC_VOICE_UDP_HOST;
	if (env.SVC_VOICE_UDP_PORT) cfg.voice_udp_port = Number(env.SVC_VOICE_UDP_PORT);
	if (env.SVC_SECRET) cfg.secret = env.SVC_SECRET;
	if (env.SVC_PUBLIC_DIR) cfg.public_dir = env.SVC_PUBLIC_DIR;
	if (env.SVC_TLS_CERT) cfg.tls = { ...(cfg.tls || {}), cert: env.SVC_TLS_CERT };
	if (env.SVC_TLS_KEY) cfg.tls = { ...(cfg.tls || {}), key: env.SVC_TLS_KEY };

	if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
		throw new ConfigError(`invalid port: ${cfg.port}`);
	}
	if (typeof cfg.secret !== "string" || cfg.secret.length < 16) {
		throw new ConfigError(
			"`secret` must be set to at least 16 characters and must match " +
				"`simple_voicechat.secret` in the Luanti server's minetest.conf. " +
				"Generate one with: openssl rand -hex 32"
		);
	}
	if (typeof cfg.voice_udp_host !== "string" || !cfg.voice_udp_host)
		throw new ConfigError("voice_udp_host must be a non-empty string");
	if (!Number.isInteger(cfg.voice_udp_port) || cfg.voice_udp_port < 1 || cfg.voice_udp_port > 65535)
		throw new ConfigError(`invalid voice_udp_port: ${cfg.voice_udp_port}`);
	if (cfg.voice_udp_port === cfg.port)
		throw new ConfigError("voice_udp_port must differ from the HTTP port");
	if (!(cfg.max_voice_distance > 0)) throw new ConfigError("max_voice_distance must be > 0");
	if (!(cfg.whisper_distance > 0)) throw new ConfigError("whisper_distance must be > 0");
	if (cfg.whisper_distance > cfg.max_voice_distance) {
		throw new ConfigError("whisper_distance must not be larger than max_voice_distance");
	}

	cfg.public_dir = resolveMaybe(baseDir, cfg.public_dir);
	if (cfg.tls) {
		const tls = {};
		for (const key of ["cert", "key"]) {
			const resolved = resolveMaybe(baseDir, cfg.tls[key]);
			if (!resolved) throw new ConfigError(`tls.${key} is required when tls is enabled`);
			if (!fs.existsSync(resolved)) throw new ConfigError(`tls.${key} not found: ${resolved}`);
			tls[key] = resolved;
		}
		cfg.tls = tls;
	}

	if (!Array.isArray(cfg.ice_servers)) throw new ConfigError("ice_servers must be an array");
	return cfg;
}
