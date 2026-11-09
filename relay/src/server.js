#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.js";
import { TokenStore } from "./tokens.js";
import { VoiceState } from "./voice.js";
import { Api } from "./api.js";
import { attachGateway } from "./wsgateway.js";
import { createVoiceUdpServer } from "./voiceudp.js";

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
};

function stripTrailingSlashes(value) {
	return value.replace(/\/+$/, "");
}

export function createVoiceServer(config, { now = Date.now, log } = {}) {
	config = { ...config, public_url: config.public_url ? stripTrailingSlashes(config.public_url) : "" };
	const logger = log ?? ((level, message) => console.log(`[voice] ${level}: ${message}`));

	const state = new VoiceState(config, { now, log: logger });
	const tokens = new TokenStore(config.token_ttl * 1000, { now });
	const api = new Api({ config, state, tokens, log: logger });

	const handler = async (req, res) => {
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("x-frame-options", "DENY");
		res.setHeader("referrer-policy", "no-referrer");
		res.setHeader(
			"content-security-policy",
			"default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
		);

		let url;
		try {
			url = new URL(req.url, "http://localhost");
		} catch {
			res.writeHead(400).end("bad request");
			return;
		}

		try {
			if (url.pathname === "/health" || url.pathname.startsWith("/api/")) {
				if (await api.handle(req, res, url)) return;
			}

			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain" }).end("method not allowed");
				return;
			}

			if (!serveStatic(req, res, config, url, logger)) {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
			}
		} catch (err) {
			logger("error", `${req.method} ${url.pathname}: ${err.stack ?? err.message}`);
			if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" }).end("internal error");
			else res.end();
		}
	};

	const server = config.tls
		? https.createServer({ cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) }, handler)
		: http.createServer(handler);

	const wss = attachGateway({ server, config, state, tokens, log: logger });

	const timer = setInterval(() => {
		state.checkStale();
		tokens.prune();
	}, 1000);
	timer.unref?.();

	async function close() {
		clearInterval(timer);
		for (const client of wss.clients) client.close(1001, "server shutting down");
		await new Promise((resolve) => wss.close(() => resolve()));
		await new Promise((resolve) => server.close(() => resolve()));
	}

	return { server, wss, state, tokens, api, close };
}

function serveStatic(req, res, config, url, log) {
	let pathname;
	try {
		pathname = decodeURIComponent(url.pathname);
	} catch {
		return false;
	}
	if (pathname === "/") pathname = "/index.html";

	const root = path.resolve(config.public_dir);
	const filePath = path.resolve(root, `.${pathname}`);
	if (filePath !== root && !filePath.startsWith(root + path.sep)) return false;

	let stat;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return false;
	}
	if (!stat.isFile()) return false;

	const ext = path.extname(filePath).toLowerCase();
	res.writeHead(200, {
		"content-type": MIME[ext] ?? "application/octet-stream",
		"content-length": stat.size,
		"cache-control": ext === ".html" ? "no-store" : "no-cache",
	});
	if (req.method === "HEAD") {
		res.end();
		return true;
	}
	const stream = fs.createReadStream(filePath);
	stream.on("error", (err) => {
		log("warn", `failed to read ${filePath}: ${err.message}`);
		res.destroy();
	});
	stream.pipe(res);
	return true;
}

async function main() {
	let config;
	try {
		config = loadConfig();
	} catch (err) {
		console.error(`[voice] configuration error: ${err.message}`);
		process.exitCode = 1;
		return;
	}

	const { server, close, state, tokens } = createVoiceServer(config);
	const voiceUdp = createVoiceUdpServer({
		config,
		state,
		tokens,
		log: (level, message) => console.log(`[voice-udp] ${level}: ${message}`),
	});
	server.listen(config.port, config.host, async () => {
		const scheme = config.tls ? "https" : "http";
		const host = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
		console.log(`[voice] listening on ${scheme}://${host}:${config.port}`);
		if (!config.tls) {
			console.log("[voice] TLS is off. Browsers only allow microphone access on localhost or HTTPS,");
			console.log("[voice] so remote players need `tls.cert` and `tls.key` in the config.");
		}
		console.log(`[voice] voice range ${config.max_voice_distance} nodes, whisper ${config.whisper_distance}`);
		try {
			const udpAddress = await voiceUdp.listen();
			console.log(`[voice] native UDP voice on ${udpAddress.address}:${udpAddress.port}`);
		} catch (err) {
			console.error(`[voice] native UDP voice failed to bind: ${err.message}`);
			process.exitCode = 1;
		}
	});

	let stopping = false;
	const shutdown = async (signal) => {
		if (stopping) return;
		stopping = true;
		console.log(`[voice] ${signal} received, shutting down`);
		await voiceUdp.close();
		await close();
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
