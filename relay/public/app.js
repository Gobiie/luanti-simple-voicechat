const $ = (id) => document.getElementById(id);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const lerp = (a, b, t) => a + (b - a) * t;

const SETTINGS_KEY = "simple_voicechat.settings.v1";

const DEFAULT_SETTINGS = {
	mode: "vad",
	pttKey: "KeyV",
	whisperKey: "KeyX",
	broadcastKey: "KeyB",
	muteKey: "KeyM",
	threshold: 0.02,
	inputGain: 1,
	autoGain: true,
	masterVolume: 1,
	inputDevice: "",
	outputDevice: "",
	spatial: true,
	compact: false,
};

function loadSettings() {
	try {
		return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

const state = {
	ws: null,
	joined: false,
	me: null,
	config: {
		max_voice_distance: 32,
		whisper_distance: 8,
		broadcast_range: 0,
		allow_recording: false,
		groups_enabled: true,
		ice_servers: [],
		invert_pan: false,
	},
	settings: loadSettings(),
	players: new Map(),
	peers: new Map(),
	volumes: new Map(),
	mutedPeers: new Set(),
	group: null,
	ctx: null,
	audio: null,
	agc: 1,
	micError: null,
	selfMuted: false,
	adminMuted: false,
	pttHeld: false,
	whisperHeld: false,
	broadcasting: false,
	voiceActiveUntil: 0,
	speakingSent: false,
	recording: null,
	rtt: null,
	keyCapture: null,
	renderAccum: 0,
};

const listeners = new Map();
const rows = new Map();

function emit(type, detail) {
	for (const handler of listeners.get(type) ?? []) {
		try {
			handler(detail);
		} catch (err) {
			console.error(err);
		}
	}
}

function saveSettings() {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
	} catch {
		/* private mode */
	}
}

function send(message) {
	if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
	try {
		state.ws.send(JSON.stringify(message));
	} catch {
		/* socket closed between checks */
	}
}

function toast(text) {
	const el = document.createElement("div");
	el.className = "toast";
	el.textContent = text;
	$("toasts").append(el);
	setTimeout(() => el.remove(), 5200);
}

function setJoinError(text) {
	$("join-error").textContent = text;
}

function prettyKey(code) {
	if (!code) return "unset";
	if (code.startsWith("Key")) return code.slice(3);
	if (code.startsWith("Digit")) return code.slice(5);
	const map = {
		Space: "Space",
		ControlLeft: "L-Ctrl",
		ControlRight: "R-Ctrl",
		ShiftLeft: "L-Shift",
		ShiftRight: "R-Shift",
		AltLeft: "L-Alt",
		AltRight: "R-Alt",
		Tab: "Tab",
		CapsLock: "Caps",
		Backquote: "`",
	};
	return map[code] ?? code;
}

function isTyping(target) {
	const tag = target?.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
}

// ---------------------------------------------------------------- microphone

function getContext() {
	if (!state.ctx) {
		const Ctx = window.AudioContext || window.webkitAudioContext;
		if (!Ctx) throw new Error("This browser has no Web Audio support.");
		state.ctx = new Ctx({ latencyHint: "interactive" });
	}
	return state.ctx;
}

function micConstraints() {
	const audio = {
		echoCancellation: true,
		noiseSuppression: true,
		autoGainControl: true,
		channelCount: 1,
	};
	if (state.settings.inputDevice) audio.deviceId = { exact: state.settings.inputDevice };
	return { audio, video: false };
}

async function startAudio() {
	if (state.audio) return state.audio;
	if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser has no microphone API.");

	const ctx = getContext();
	await ctx.resume();

	let stream;
	try {
		stream = await navigator.mediaDevices.getUserMedia(micConstraints());
	} catch (err) {
		// Playback does not need a microphone, so keep the shared context even
		// when capture is denied or no input device exists.
		if (err?.name === "OverconstrainedError" && state.settings.inputDevice) {
			state.settings.inputDevice = "";
			saveSettings();
			return startAudio();
		}
		throw err;
	}

	const source = ctx.createMediaStreamSource(stream);
	const input = ctx.createGain();
	input.gain.value = state.settings.inputGain;

	const analyser = ctx.createAnalyser();
	analyser.fftSize = 1024;
	analyser.smoothingTimeConstant = 0.7;

	const gate = ctx.createGain();
	gate.gain.value = 0;

	const dest = ctx.createMediaStreamDestination();
	const monitor = ctx.createGain();
	monitor.gain.value = 0;

	source.connect(input);
	input.connect(analyser);
	input.connect(gate);
	gate.connect(dest);
	gate.connect(monitor);
	monitor.connect(ctx.destination);

	state.audio = {
		ctx,
		stream,
		source,
		input,
		analyser,
		gate,
		dest,
		monitor,
		track: dest.stream.getAudioTracks()[0],
		buffer: new Float32Array(analyser.fftSize),
	};

	for (const peer of state.peers.values()) {
		peer.transceiver?.sender.replaceTrack(state.audio.track).catch(() => {});
	}

	state.micError = null;
	$("mic-status").style.cursor = "";
	setMicStatus();
	void refreshDevices();
	void applyOutputDevice();
	return state.audio;
}

async function retryMicrophone() {
	if (state.audio) return;
	try {
		await startAudio();
		toast("Microphone enabled.");
	} catch (err) {
		state.micError = err.message;
		$("mic-status").textContent = "Microphone blocked by the browser";
		toast(`Microphone unavailable: ${err.message}`);
	}
}

function micOpen(now) {
	if (!state.audio || state.selfMuted || state.adminMuted) return false;
	if (state.whisperHeld) return true;
	if (state.settings.mode === "ptt") return state.pttHeld;
	return now < state.voiceActiveUntil;
}

function setMicStatus(open) {
	if (state.micError) {
		$("mic-status").textContent = "Microphone unavailable - click to retry";
		$("mic-status").style.cursor = "pointer";
		return;
	}
	if (!state.audio) {
		$("mic-status").textContent = "Microphone off";
		return;
	}
	if (state.adminMuted) {
		$("mic-status").textContent = "Muted by an admin";
		return;
	}
	if (state.selfMuted) {
		$("mic-status").textContent = "Muted";
		return;
	}
	const openNow = open ?? micOpen(performance.now());
	$("mic-status").textContent = openNow ? "Transmitting" : "Ready";
	$("mic-mode").textContent =
		state.settings.mode === "ptt" ? `Push to talk (${prettyKey(state.settings.pttKey)})` : "Voice activation";
}

// -------------------------------------------------------------------- socket

function connect(credential) {
	const proto = location.protocol === "https:" ? "wss" : "ws";
	let ws;
	try {
		ws = new WebSocket(`${proto}://${location.host}/ws`);
	} catch {
		failJoin("Could not open a connection to the relay.");
		return;
	}
	state.ws = ws;
	$("join-button").textContent = "Connecting…";

	ws.addEventListener("open", () => send({ type: "auth", token: credential }));
	ws.addEventListener("message", (event) => {
		let message;
		try {
			message = JSON.parse(event.data);
		} catch {
			return;
		}
		handleMessage(message);
	});
	ws.addEventListener("close", (event) => {
		state.ws = null;
		const reason = closeReason(event);
		if (state.joined) endSession(reason);
		else failJoin(reason);
	});
	ws.addEventListener("error", () => {});
}

function closeReason(event) {
	switch (event.code) {
		case 4003:
			return event.reason || "That join code is invalid or expired. Run /voice again.";
		case 4002:
			return "This player joined from another tab.";
		case 4001:
			return event.reason || "You were removed from voice chat.";
		case 1001:
			return "The relay is shutting down.";
		default:
			return "The connection to the relay closed.";
	}
}

function failJoin(reason) {
	$("join-button").disabled = false;
	$("join-button").textContent = "Join voice";
	setJoinError(reason);
}

function endSession(reason) {
	teardown();
	$("join").hidden = false;
	$("app").hidden = true;
	setJoinError(reason);
	$("join-button").disabled = false;
	$("join-button").textContent = "Join voice";
}

function handleMessage(message) {
	switch (message.type) {
		case "welcome":
			onWelcome(message);
			break;
		case "positions":
			onPositions(message.players ?? []);
			break;
		case "connect":
			ensurePeer(message.peer, Boolean(message.initiator));
			break;
		case "link":
			onLink(message.peer.id, Boolean(message.hear));
			break;
		case "disconnect":
			destroyPeer(message.peer.id);
			break;
		case "peer.left":
			onPeerLeft(message.peer.id);
			break;
		case "signal":
			void onSignal(message.from, message.data);
			break;
		case "group":
			state.group = message.group;
			renderGroup();
			emit("group", state.group);
			break;
		case "notice":
			toast(message.message);
			break;
		case "speaking":
			onSpeaking(message.id, Boolean(message.on));
			break;
		case "broadcast":
			state.broadcasting = Boolean(message.on);
			$("broadcast-button").classList.toggle("active", state.broadcasting);
			break;
		case "admin_mute":
			state.adminMuted = Boolean(message.muted);
			setMicStatus();
			toast(state.adminMuted ? "An admin muted your microphone." : "An admin allowed your microphone again.");
			break;
		case "error":
			toast(message.message);
			break;
		case "pong":
			state.rtt = Math.round(performance.now() - Number(message.t ?? performance.now()));
			$("rtt").textContent = `${state.rtt} ms`;
			break;
		default:
			break;
	}
}

function onWelcome(message) {
	state.me = message.you;
	state.config = { ...state.config, ...message.config };
	state.joined = true;
	state.group = null;
	state.broadcasting = false;
	state.whisperHeld = false;
	state.pttHeld = false;
	state.adminMuted = false;
	$("broadcast-button").classList.remove("active");

	history.replaceState({}, "", location.pathname);
	$("join").hidden = true;
	$("app").hidden = false;
	$("me-name").textContent = message.you.name;
	$("conn-dot").classList.add("online");
	$("me-state").textContent = "connected";
	$("broadcast-button").hidden = !(state.config.broadcast_range > 0);
	$("record-button").hidden = !state.config.allow_recording;
	$("range-info").textContent =
		`${state.config.max_voice_distance} nodes, whisper ${state.config.whisper_distance}` +
		(state.config.broadcast_range > 0 ? `, broadcast ${state.config.broadcast_range}` : ", broadcast off");

	setMicStatus();
	applySettingsToUi();
	void refreshDevices();
	void applyOutputDevice();
	send({ type: "self_mute", muted: state.selfMuted });
	emit("connect", message.you);
}

// ------------------------------------------------------------------ peers

function ensurePeer(peer, initiator) {
	const existing = state.peers.get(peer.id);
	if (existing) return existing;

	const pc = new RTCPeerConnection({ iceServers: state.config.ice_servers ?? [] });
	const entry = {
		id: peer.id,
		name: peer.name,
		pc,
		initiator,
		hear: true,
		muted: state.mutedPeers.has(peer.id),
		volume: state.volumes.get(peer.id) ?? 1,
		nodes: null,
		transceiver: null,
		remoteStream: null,
		pendingCandidates: [],
	};
	state.peers.set(peer.id, entry);

	const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
	entry.transceiver = transceiver;
	if (state.audio?.track) transceiver.sender.replaceTrack(state.audio.track).catch(() => {});

	pc.onicecandidate = (event) => {
		if (event.candidate) send({ type: "signal", to: peer.id, data: { candidate: event.candidate } });
	};
	pc.ontrack = (event) => {
		const stream = event.streams[0] ?? new MediaStream([event.track]);
		attachRemote(entry, stream);
	};
	pc.onconnectionstatechange = () => {
		if (pc.connectionState === "failed") {
			toast(`Audio connection to ${peer.name} failed. Check the network between you.`);
			destroyPeer(peer.id);
		}
	};

	if (initiator) void negotiate(entry);
	syncRoster();
	return entry;
}

async function negotiate(entry) {
	try {
		const offer = await entry.pc.createOffer();
		await entry.pc.setLocalDescription(offer);
		send({ type: "signal", to: entry.id, data: { sdp: entry.pc.localDescription } });
	} catch (err) {
		toast(`Could not start audio with ${entry.name}: ${err.message}`);
	}
}

async function onSignal(from, data) {
	const entry = state.peers.get(from);
	if (!entry || !data) return;
	try {
		if (data.sdp) {
			await entry.pc.setRemoteDescription(data.sdp);
			for (const candidate of entry.pendingCandidates.splice(0)) {
				await entry.pc.addIceCandidate(candidate).catch(() => {});
			}
			if (data.sdp.type === "offer") {
				const answer = await entry.pc.createAnswer();
				await entry.pc.setLocalDescription(answer);
				send({ type: "signal", to: from, data: { sdp: entry.pc.localDescription } });
			}
		} else if (data.candidate) {
			if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate).catch(() => {});
			else entry.pendingCandidates.push(data.candidate);
		}
	} catch (err) {
		toast(`Audio negotiation with ${entry.name} failed: ${err.message}`);
	}
}

function attachRemote(entry, stream) {
	let ctx;
	try {
		ctx = getContext();
	} catch {
		return;
	}

	if (entry.nodes) {
		try {
			entry.nodes.src.disconnect();
			entry.nodes.gain.disconnect();
		} catch {
			/* already detached */
		}
	}

	const src = ctx.createMediaStreamSource(stream);
	const panner = new PannerNode(ctx, {
		panningModel: "HRTF",
		distanceModel: "inverse",
		refDistance: 3,
		rolloffFactor: 1.4,
		maxDistance: 400,
		coneInnerAngle: 360,
		coneOuterAngle: 360,
	});
	const gain = ctx.createGain();
	src.connect(panner);
	panner.connect(gain);
	gain.connect(ctx.destination);

	entry.nodes = { src, panner, gain };
	entry.remoteStream = stream;
	applyPeerGain(entry);

	if (state.recording) {
		gain.connect(state.recording.dest);
		recordStream(entry.name, stream);
	}
}

function applyPeerGain(entry) {
	if (!entry.nodes || !state.ctx) return;
	const audible = entry.hear && !entry.muted;
	const target = audible ? entry.volume * state.settings.masterVolume : 0;
	entry.nodes.gain.gain.setTargetAtTime(target, state.ctx.currentTime, 0.05);
}

function applyAllGains() {
	for (const peer of state.peers.values()) applyPeerGain(peer);
}

function onLink(id, hear) {
	const entry = state.peers.get(id);
	if (!entry) return;
	entry.hear = hear;
	applyPeerGain(entry);		const row = rows.get(id);
		if (row) row.el.classList.toggle("inaudible", !hear);
}

function destroyPeer(id) {
	const entry = state.peers.get(id);
	if (!entry) return;
	try {
		entry.pc.close();
	} catch {
		/* already closed */
	}
	try {
		entry.nodes?.src.disconnect();
		entry.nodes?.gain.disconnect();
	} catch {
		/* already detached */
	}
	state.peers.delete(id);
	syncRoster();
}

function onPeerLeft(id) {
	destroyPeer(id);
	state.players.delete(id);
	const row = rows.get(id);
	if (row) {
		row.el.remove();
		rows.delete(id);
	}
	syncRoster();
}

function onSpeaking(id, on) {
	if (state.me && id === state.me.id) return;
	const player = state.players.get(id);
	if (player) player.speaking = on;
	const row = rows.get(id);
	if (row) row.el.classList.toggle("speaking", on);
	emit("speaking", { id, speaking: on });
}

// ----------------------------------------------------------------- spatial

function onPositions(players) {
	const seen = new Set();
	for (const player of players) {
		seen.add(player.id);
		const previous = state.players.get(player.id);
		state.players.set(player.id, {
			...player,
			smooth: previous?.smooth ? previous.smooth : [...player.pos],
		});
	}
	for (const id of [...state.players.keys()]) {
		if (!seen.has(id)) state.players.delete(id);
	}
	syncRoster();
}

function updateSpatial() {
	const me = state.me ? state.players.get(state.me.id) : null;
	if (!me) return;

	const yaw = me.yaw || 0;
	// Luanti: left-handed, +X right, +Z forward, positive yaw turns left.
	const fx = -Math.sin(yaw);
	const fz = Math.cos(yaw);
	const rx = Math.cos(yaw);
	const rz = Math.sin(yaw);

	for (const [id, peer] of state.peers) {
		const player = state.players.get(id);
		if (!player || !peer.nodes) continue;

		for (let i = 0; i < 3; i++) player.smooth[i] = lerp(player.smooth[i], player.pos[i], 0.18);
		const dx = player.smooth[0] - me.pos[0];
		const dy = player.smooth[1] - me.pos[1];
		const dz = player.smooth[2] - me.pos[2];

		const panner = peer.nodes.panner;
		if (!state.settings.spatial) {
			panner.positionX.value = 0;
			panner.positionY.value = 0;
			panner.positionZ.value = -1;
			continue;
		}

		let x = dx * rx + dz * rz;
		const forward = dx * fx + dz * fz;
		if (state.config.invert_pan) x = -x;
		panner.positionX.value = x;
		panner.positionY.value = dy;
		panner.positionZ.value = -forward;
	}
}

function distanceTo(player) {
	const me = state.me ? state.players.get(state.me.id) : null;
	if (!me || !player) return 0;
	const dx = player.pos[0] - me.pos[0];
	const dy = player.pos[1] - me.pos[1];
	const dz = player.pos[2] - me.pos[2];
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ------------------------------------------------------------------ roster

function syncRoster() {
	const seen = new Set();
	for (const [id, player] of state.players) {
		if (state.me && id === state.me.id) continue;
		seen.add(id);

		let row = rows.get(id);
		if (!row) {
			row = createRow(id, player);
			rows.set(id, row);
		}

		row.name.textContent = player.name;
		row.group.textContent = player.group ?? "";
		row.group.hidden = !player.group;
		row.el.classList.toggle("speaking", Boolean(player.speaking));
		const peer = state.peers.get(id);
		row.el.classList.toggle("inaudible", Boolean(peer) && !peer.hear);
		row.dist.textContent = `${Math.round(distanceTo(player))}m`;
	}

	for (const [id, row] of rows) {
		if (seen.has(id)) continue;
		row.el.remove();
		rows.delete(id);
	}

	$("player-count").textContent = String(seen.size);
	$("roster-empty").hidden = seen.size > 0;
}

function createRow(id, player) {
	const el = document.createElement("li");
	el.className = "player";

	const dot = document.createElement("span");
	dot.className = "speak-dot";

	const name = document.createElement("span");
	name.className = "p-name";
	name.textContent = player.name;

	const group = document.createElement("span");
	group.className = "tag";
	group.hidden = !player.group;

	const dist = document.createElement("span");
	dist.className = "p-dist";

	const volume = document.createElement("input");
	volume.type = "range";
	volume.className = "p-vol";
	volume.min = "0";
	volume.max = "1.5";
	volume.step = "0.05";
	volume.value = String(state.volumes.get(id) ?? 1);
	volume.title = "Volume for this player";
	volume.addEventListener("input", () => {
		const value = Number(volume.value);
		state.volumes.set(id, value);
		const peer = state.peers.get(id);
		if (peer) {
			peer.volume = value;
			applyPeerGain(peer);
		}
	});

	const mute = document.createElement("button");
	mute.className = "p-mute";
	mute.textContent = "Mute";
	mute.addEventListener("click", () => {
		const muted = !state.mutedPeers.has(id);
		if (muted) state.mutedPeers.add(id);
		else state.mutedPeers.delete(id);
		mute.classList.toggle("on", muted);
		mute.textContent = muted ? "Unmute" : "Mute";
		const peer = state.peers.get(id);
		if (peer) {
			peer.muted = muted;
			applyPeerGain(peer);
		}
		emit("mute", { id, muted });
	});
	if (state.mutedPeers.has(id)) {
		mute.classList.add("on");
		mute.textContent = "Unmute";
	}

	el.append(dot, name, group, dist, volume, mute);
	$("roster").append(el);
	return { el, name, group, dist, volume, mute };
}

// ------------------------------------------------------------------- group

function renderGroup() {
	const group = state.group;
	$("group-current").hidden = !group;
	$("group-form").hidden = Boolean(group);
	if (!group) return;
	$("group-name").textContent = group.name;
	$("group-type-label").textContent = group.type ?? "normal";
	$("group-locked").hidden = !group.locked;
	$("group-members").textContent = `Members: ${(group.members ?? []).join(", ")}`;
}

// ---------------------------------------------------------------- settings

function applySettingsToUi() {
	$("mode-select").value = state.settings.mode;
	$("input-device").value = state.settings.inputDevice ?? "";
	$("output-device").value = state.settings.outputDevice ?? "";
	$("threshold").value = String(state.settings.threshold);
	$("threshold-value").textContent = state.settings.threshold.toFixed(3);
	$("input-gain").value = String(state.settings.inputGain);
	$("gain-value").textContent = `${state.settings.inputGain.toFixed(1)}x`;
	$("auto-gain").checked = state.settings.autoGain;
	$("input-gain").disabled = state.settings.autoGain;
	$("master-volume").value = String(state.settings.masterVolume);
	$("volume-value").textContent = state.settings.masterVolume.toFixed(2);
	$("spatial").checked = state.settings.spatial;
	$("compact").checked = state.settings.compact;
	document.body.classList.toggle("compact", state.settings.compact);
	$("mic-mode").textContent =
		state.settings.mode === "ptt" ? `Push to talk (${prettyKey(state.settings.pttKey)})` : "Voice activation";

	for (const button of document.querySelectorAll(".keybind")) {
		const action = button.dataset.action;
		button.querySelector("kbd").textContent = prettyKey(state.settings[action]);
		button.classList.toggle("capturing", state.keyCapture === action);
		button.querySelector("kbd").textContent = state.keyCapture === action ? "press a key" : prettyKey(state.settings[action]);
	}

	if (state.audio) {
		state.audio.input.gain.setTargetAtTime(
			state.settings.inputGain * state.agc,
			state.audio.ctx.currentTime,
			0.05
		);
	}
	applyAllGains();
	setMicStatus();
}

function fillDeviceSelect(id, devices, selected, defaultLabel) {
	const select = $(id);
	if (!select) return;
	select.replaceChildren();
	const fallback = document.createElement("option");
	fallback.value = "";
	fallback.textContent = defaultLabel;
	select.append(fallback);
	for (const device of devices) {
		const option = document.createElement("option");
		option.value = device.deviceId;
		option.textContent = device.label || `${defaultLabel} (${select.options.length})`;
		select.append(option);
	}
	const exists = [...select.options].some((option) => option.value === selected);
	select.value = exists ? selected : "";
}

function canSelectOutput() {
	const Ctx = window.AudioContext || window.webkitAudioContext;
	return Boolean(Ctx && "setSinkId" in Ctx.prototype);
}

async function refreshDevices() {
	if (!navigator.mediaDevices?.enumerateDevices) return;
	let devices;
	try {
		devices = await navigator.mediaDevices.enumerateDevices();
	} catch {
		return;
	}
	fillDeviceSelect(
		"input-device",
		devices.filter((device) => device.kind === "audioinput"),
		state.settings.inputDevice,
		"System default microphone"
	);
	fillDeviceSelect(
		"output-device",
		devices.filter((device) => device.kind === "audiooutput"),
		state.settings.outputDevice,
		"System default speakers"
	);
	const outputSelect = $("output-device");
	if (outputSelect) {
		outputSelect.disabled = !canSelectOutput();
		outputSelect.title = canSelectOutput() ? "" : "This browser cannot choose an output device.";
	}
}

async function applyOutputDevice() {
	if (!state.ctx?.setSinkId) return;
	try {
		await state.ctx.setSinkId(state.settings.outputDevice || "");
	} catch {
		/* some browsers require a gesture; the current output stays */
	}
}

async function switchInputDevice(deviceId) {
	state.settings.inputDevice = deviceId;
	saveSettings();
	if (!state.audio) return;
	const old = state.audio;
	let stream;
	try {
		stream = await navigator.mediaDevices.getUserMedia(micConstraints());
	} catch (err) {
		toast(`Could not switch microphone: ${err.message}`);
		if (deviceId) {
			state.settings.inputDevice = "";
			saveSettings();
			applySettingsToUi();
			void refreshDevices();
		}
		return;
	}
	const source = old.ctx.createMediaStreamSource(stream);
	source.connect(old.input);
	try {
		old.source.disconnect();
	} catch {
		/* already disconnected */
	}
	for (const track of old.stream.getTracks()) track.stop();
	old.stream = stream;
	old.source = source;
	toast("Microphone switched.");
}

function bindSettings() {
	$("input-device").addEventListener("change", () => void switchInputDevice($("input-device").value));
	$("output-device").addEventListener("change", () => {
		state.settings.outputDevice = $("output-device").value;
		saveSettings();
		void applyOutputDevice();
	});
	navigator.mediaDevices?.addEventListener?.("devicechange", () => void refreshDevices());
	$("mode-select").addEventListener("change", () => {
		state.settings.mode = $("mode-select").value;
		saveSettings();
		applySettingsToUi();
	});
	$("threshold").addEventListener("input", () => {
		state.settings.threshold = Number($("threshold").value);
		$("threshold-value").textContent = state.settings.threshold.toFixed(3);
		saveSettings();
	});
	$("input-gain").addEventListener("input", () => {
		state.settings.inputGain = Number($("input-gain").value);
		$("gain-value").textContent = `${state.settings.inputGain.toFixed(1)}x`;
		saveSettings();
		applySettingsToUi();
	});
	$("master-volume").addEventListener("input", () => {
		state.settings.masterVolume = Number($("master-volume").value);
		$("volume-value").textContent = state.settings.masterVolume.toFixed(2);
		saveSettings();
		applyAllGains();
	});
	$("spatial").addEventListener("change", () => {
		state.settings.spatial = $("spatial").checked;
		saveSettings();
	});
	$("auto-gain").addEventListener("change", () => {
		state.settings.autoGain = $("auto-gain").checked;
		state.agc = 1;
		saveSettings();
		applySettingsToUi();
	});
	$("compact").addEventListener("change", () => {
		state.settings.compact = $("compact").checked;
		saveSettings();
		applySettingsToUi();
	});

	for (const button of document.querySelectorAll(".keybind")) {
		button.addEventListener("click", () => {
			state.keyCapture = state.keyCapture === button.dataset.action ? null : button.dataset.action;
			applySettingsToUi();
		});
	}
}

// ------------------------------------------------------------------ actions

function toggleMute() {
	state.selfMuted = !state.selfMuted;
	send({ type: "self_mute", muted: state.selfMuted });
	$("mute-button").classList.toggle("active", state.selfMuted);
	$("mute-button").textContent = state.selfMuted ? "Unmute" : "Mute";
	setMicStatus();
}

function setWhisper(on) {
	if (state.whisperHeld === on) return;
	state.whisperHeld = on;
	send({ type: "whisper", on });
	$("whisper-button").classList.toggle("active", on);
}

function toggleBroadcast() {
	if (!(state.config.broadcast_range > 0)) return;
	send({ type: "broadcast", on: !state.broadcasting });
}

function testSpeaker() {
	let ctx;
	try {
		ctx = getContext();
	} catch (err) {
		toast(err.message);
		return;
	}
	void ctx.resume().catch(() => {});
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = "sine";
	osc.frequency.value = 440;
	gain.gain.value = 0.0001;
	osc.connect(gain);
	gain.connect(ctx.destination);
	const now = ctx.currentTime;
	gain.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.18 * state.settings.masterVolume), now + 0.05);
	gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
	osc.start(now);
	osc.stop(now + 1);
}

function toggleMonitor() {
	if (!state.audio) {
		toast("Join first so the microphone is available.");
		return;
	}
	const on = state.audio.monitor.gain.value < 0.5;
	state.audio.monitor.gain.setTargetAtTime(on ? 1 : 0, state.audio.ctx.currentTime, 0.02);
	$("monitor-button").classList.toggle("active", on);
}

// ---------------------------------------------------------------- recording

function pickMimeType() {
	const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
	for (const type of candidates) {
		if (window.MediaRecorder?.isTypeSupported?.(type)) return type;
	}
	return "";
}

function startRecording() {
	if (state.recording) return;
	if (!state.config.allow_recording) {
		toast("Recording is disabled by this server.");
		return;
	}
	let ctx;
	try {
		ctx = getContext();
	} catch (err) {
		toast(err.message);
		return;
	}
	const dest = ctx.createMediaStreamDestination();
	state.recording = { dest, recorders: new Map(), started: Date.now() };

	for (const peer of state.peers.values()) peer.nodes?.gain.connect(dest);
	if (state.audio) state.audio.gate.connect(dest);

	let recorders = 0;
	if (recordStream("mixed", dest.stream)) recorders += 1;
	if (state.audio && recordStream("you", state.audio.dest.stream)) recorders += 1;
	for (const peer of state.peers.values()) {
		if (peer.remoteStream && recordStream(peer.name, peer.remoteStream)) recorders += 1;
	}
	if (recorders === 0) {
		state.recording = null;
		for (const peer of state.peers.values()) {
			try {
				peer.nodes?.gain.disconnect(dest);
			} catch {
				/* not connected */
			}
		}
		try {
			state.audio?.gate.disconnect(dest);
		} catch {
			/* not connected */
		}
		toast("Recording is not supported by this browser.");
		return;
	}

	$("record-button").classList.add("active");
	$("record-button").textContent = "Stop recording";
	toast("Recording started.");
}

function stopRecording() {
	const recording = state.recording;
	state.recording = null;
	if (!recording) return;
	const existing = $("recording-list").children.length;

	for (const recorder of recording.recorders.values()) {
		try {
			recorder.stop();
		} catch {
			/* already stopped */
		}
	}
	for (const peer of state.peers.values()) {
		try {
			peer.nodes?.gain.disconnect(recording.dest);
		} catch {
			/* not connected */
		}
	}
	try {
		state.audio?.gate.disconnect(recording.dest);
	} catch {
		/* not connected */
	}

	$("record-button").classList.remove("active");
	$("record-button").textContent = "Record";
	toast("Recording stopped.");
	setTimeout(() => {
		if ($("recording-list").children.length === existing) {
			toast("No audio was captured. Check that the browser can play audio.");
		}
	}, 2500);
}

function recordStream(label, stream) {
	if (!state.recording || state.recording.recorders.has(label)) return;
	const mimeType = pickMimeType();
	let recorder;
	try {
		recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
	} catch {
		return false;
	}
	const chunks = [];
	recorder.addEventListener("dataavailable", (event) => {
		if (event.data.size > 0) chunks.push(event.data);
	});
	recorder.addEventListener("stop", () => {
		if (chunks.length > 0) addRecording(label, new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
	});
	try {
		recorder.start(1000);
	} catch {
		return false;
	}
	state.recording.recorders.set(label, recorder);
	return true;
}

function addRecording(label, blob) {
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	const link = document.createElement("a");
	link.href = URL.createObjectURL(blob);
	link.download = `voice-${label.replace(/[^\w.-]+/g, "_")}-${stamp}.webm`;
	link.textContent = `${label} (${Math.max(1, Math.round(blob.size / 1024))} KB)`;

	const item = document.createElement("li");
	item.append(link);
	$("recording-list").append(item);
	$("recordings").hidden = false;
}

// ------------------------------------------------------------------- render

function tick(now) {
	requestAnimationFrame(tick);
	const audio = state.audio;
	if (!audio) {
		updateSpatial();
		return;
	}

	audio.analyser.getFloatTimeDomainData(audio.buffer);
	let sum = 0;
	for (let i = 0; i < audio.buffer.length; i++) sum += audio.buffer[i] * audio.buffer[i];
	const rms = Math.sqrt(sum / audio.buffer.length);

	$("meter-fill").style.width = `${clamp((rms / 0.25) * 100, 0, 100).toFixed(1)}%`;
	$("meter-threshold").style.left = `${clamp((state.settings.threshold / 0.25) * 100, 0, 100).toFixed(1)}%`;

	if (state.settings.mode === "vad" && !state.selfMuted && rms > state.settings.threshold) {
		state.voiceActiveUntil = now + 300;
	}

	if (state.settings.autoGain && rms > 0.004 && !state.selfMuted && now - (state.lastAgc ?? 0) > 500) {
		state.lastAgc = now;
		const desired = clamp(state.agc * (0.08 / rms), 0.4, 4);
		state.agc = lerp(state.agc, desired, 0.3);
		audio.input.gain.setTargetAtTime(state.settings.inputGain * state.agc, audio.ctx.currentTime, 0.2);
	}

	const open = micOpen(now);
	audio.gate.gain.setTargetAtTime(open ? 1 : 0, audio.ctx.currentTime, 0.015);
	if (open !== state.speakingSent) {
		state.speakingSent = open;
		send({ type: "speaking", on: open });
		setMicStatus(open);
		emit("speaking", { id: state.me?.id, speaking: open });
	}

	updateSpatial();

	if (now - state.renderAccum > 250) {
		state.renderAccum = now;
		for (const [id, player] of state.players) {
			const row = rows.get(id);
			if (row) row.dist.textContent = `${Math.round(distanceTo(player))}m`;
		}
	}
}

// -------------------------------------------------------------------- setup

function teardown() {
	for (const peer of [...state.peers.values()]) {
		try {
			peer.pc.close();
		} catch {
			/* already closed */
		}
	}
	state.peers.clear();
	state.players.clear();
	state.group = null;
	for (const row of rows.values()) row.el.remove();
	rows.clear();
	$("roster").replaceChildren();
	$("player-count").textContent = "0";

	if (state.recording) {
		for (const recorder of state.recording.recorders.values()) {
			try {
				recorder.stop();
			} catch {
				/* already stopped */
			}
		}
		state.recording = null;
	}
	if (state.audio) {
		for (const track of state.audio.stream.getTracks()) track.stop();
		state.audio = null;
	}
	if (state.ctx) {
		state.ctx.close().catch(() => {});
		state.ctx = null;
	}

	state.joined = false;
	state.me = null;
	state.speakingSent = false;
	state.broadcasting = false;
	state.whisperHeld = false;
	state.pttHeld = false;
	state.adminMuted = false;
	state.selfMuted = false;
	state.mutedPeers.clear();
	state.volumes.clear();
	$("conn-dot").classList.remove("online");
	$("me-state").textContent = "disconnected";
	$("mute-button").classList.remove("active");
	$("mute-button").textContent = "Mute";
	$("broadcast-button").classList.remove("active");
	renderGroup();
}

function bindUi() {
	$("join-form").addEventListener("submit", (event) => {
		event.preventDefault();
		const link = $("link").value.trim();
		let credential = $("code").value.trim().toUpperCase();
		if (link) {
			try {
				const url = new URL(link, location.origin);
				credential = url.searchParams.get("t") ?? credential;
			} catch {
				/* not a URL, use the code */
			}
		}
		if (!credential) {
			setJoinError("Enter the code from /voice, or paste a voice link.");
			return;
		}
		$("join-button").disabled = true;
		setJoinError("");
		state.micError = null;
		void (async () => {
			try {
				await startAudio();
			} catch (err) {
				state.micError = err.message;
			}
			if (state.ws) return;
			connect(credential);
		})();
	});

	$("mic-status").addEventListener("click", () => void retryMicrophone());
	$("mute-button").addEventListener("click", toggleMute);
	$("whisper-button").addEventListener("click", () => toast("Hold the whisper key to whisper."));
	$("broadcast-button").addEventListener("click", toggleBroadcast);
	$("record-button").addEventListener("click", () => (state.recording ? stopRecording() : startRecording()));
	$("test-speaker").addEventListener("click", testSpeaker);
	$("monitor-button").addEventListener("click", toggleMonitor);
	$("settings-toggle").addEventListener("click", () => {
		$("settings").hidden = !$("settings").hidden;
	});
	$("leave-button").addEventListener("click", () => {
		if (state.ws) {
			state.joined = false;
			try {
				state.ws.close(1000, "left");
			} catch {
				/* already closed */
			}
			state.ws = null;
		}
		endSession("You left voice chat.");
	});

	$("group-form").addEventListener("submit", (event) => {
		event.preventDefault();
		const name = $("group-input").value.trim();
		if (!name) return;
		send({
			type: "group.join",
			name,
			password: $("group-password").value,
			groupType: $("group-type").value,
		});
	});
	$("group-leave").addEventListener("click", () => send({ type: "group.leave" }));
	$("group-invite-form").addEventListener("submit", (event) => {
		event.preventDefault();
		const player = $("group-invite-name").value.trim();
		if (!player) return;
		send({ type: "group.invite", player });
		$("group-invite-name").value = "";
	});

	bindSettings();

	window.addEventListener("keydown", (event) => {
		if (state.keyCapture) {
			event.preventDefault();
			if (event.code === "Escape") {
				state.keyCapture = null;
			} else {
				state.settings[state.keyCapture] = event.code;
				state.keyCapture = null;
				saveSettings();
			}
			applySettingsToUi();
			return;
		}
		if (isTyping(event.target)) return;
		if (!state.joined) return;

		const keys = state.settings;
		if (event.code === keys.muteKey && !event.repeat) {
			event.preventDefault();
			toggleMute();
			return;
		}
		if (event.code === keys.whisperKey) {
			event.preventDefault();
			setWhisper(true);
			return;
		}
		if (event.code === keys.broadcastKey && !event.repeat) {
			event.preventDefault();
			toggleBroadcast();
			return;
		}
		if (event.code === keys.pttKey && !event.repeat) {
			event.preventDefault();
			state.pttHeld = true;
		}
	});

	window.addEventListener("keyup", (event) => {
		if (event.code === state.settings.pttKey) state.pttHeld = false;
		if (event.code === state.settings.whisperKey) setWhisper(false);
	});

	window.addEventListener("blur", () => {
		state.pttHeld = false;
		setWhisper(false);
	});

	setInterval(() => {
		if (state.joined) send({ type: "ping", t: performance.now() });
	}, 5000);

	window.addEventListener("beforeunload", () => {
		try {
			state.ws?.close(1000, "page closed");
		} catch {
			/* ignore */
		}
	});
}

function boot() {
	const token = new URLSearchParams(location.search).get("t");
	if (token) {
		$("link").value = location.href;
		$("link-details").open = true;
		$("join-error").textContent = "Joining with your link…";
		$("code").value = "";
	}

	bindUi();
	applySettingsToUi();
	renderGroup();
	requestAnimationFrame(tick);

	// Pre-fill from ?t= but still require a click: browsers need a gesture
	// before audio may start, and the token is single use.
	if (token) setTimeout(() => $("join-button").focus(), 50);
}

boot();

// ---------------------------------------------------------------- public API

window.SimpleVoiceChat = {
	isConnected: () => state.joined,
	getMe: () => state.me,
	getConfig: () => ({ ...state.config }),
	getGroup: () => state.group,
	getPlayers: () =>
		[...state.players.values()].map((player) => {
			const copy = { ...player };
			delete copy.smooth;
			return copy;
		}),
	getPeers: () =>
		[...state.peers.values()].map((peer) => ({
			id: peer.id,
			name: peer.name,
			state: peer.pc.connectionState,
			ice: peer.pc.iceConnectionState,
			signaling: peer.pc.signalingState,
			initiator: peer.initiator,
			local: peer.pc.localDescription?.type ?? null,
			remote: peer.pc.remoteDescription?.type ?? null,
			pendingCandidates: peer.pendingCandidates.length,
			hear: peer.hear,
			muted: peer.muted,
			volume: peer.volume,
		})),
	setMuted(muted) {
		if (state.selfMuted !== Boolean(muted)) toggleMute();
	},
	setInputGain(value) {
		state.settings.inputGain = clamp(Number(value) || 1, 0.2, 4);
		saveSettings();
		applySettingsToUi();
	},
	joinGroup(name, password = "", groupType = "normal") {
		send({ type: "group.join", name, password, groupType });
	},
	leaveGroup() {
		send({ type: "group.leave" });
	},
	startRecording,
	stopRecording,
	on(event, handler) {
		const list = listeners.get(event) ?? [];
		list.push(handler);
		listeners.set(event, list);
		return () => {
			listeners.set(
				event,
				(listeners.get(event) ?? []).filter((entry) => entry !== handler)
			);
		};
	},
};
