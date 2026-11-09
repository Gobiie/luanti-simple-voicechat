# Simple Voice Chat for Luanti

A proximity voice chat system for [Luanti](https://www.luanti.org/) (formerly Minetest),
modelled feature-for-feature on [Simple Voice Chat](https://github.com/henkelmax/simple-voice-chat)
for Minecraft.

It gives you: proximity audio, password-protected groups, whispering, broadcast,
push-to-talk, voice activation, automatic microphone gain, per-player volume,
3D positional audio, recording with separate tracks, moderation commands and an
API. The native client fork in `client/` now brings the audio path into the
Luanti window — microphone capture, Opus, UDP and 3D OpenAL playback — rather
than only into a browser tab. See [Native client](#native-client-in-game-voice).

## Native client (in-game voice)

`client/patches/0001-native-voicechat.patch` applies to Luanti commit
`18cbd54dbbc0449b8329dd6fe32bdb387e63bb79` and adds a real in-engine voice path:

- OpenAL capture and playback on a dedicated audio thread.
- Opus 48 kHz mono, 20 ms frames, 32 kbit/s, in-band FEC.
- Native UDP transport (`SVL1`) with the relay's existing token and
  `VoiceState` routing.
- 3D positional sources for every audible speaker.
- Push-to-talk on `F`; `/voice` sends the patched client a private token line
  and it connects automatically.

Build it with [client/README.md](client/README.md). The relay must expose its
UDP listener (`voice_udp_port`, default 8091) in addition to the HTTP port.

## Why this is a relay and a browser panel

Luanti mods are Lua scripts that run on the **server**. The client scripting API
(CSM) exists but is experimental, disabled by most servers with
`csm_restriction_flags = 62`, and has no microphone capture and no raw sockets.
There is no audio input API anywhere in the engine, so no Luanti mod can capture
or stream voice.

This project therefore splits the job the same way Simple Voice Chat does, just
with different parts:

```
┌──────────────────┐   HTTPS (positions, tokens, moderation)   ┌──────────────────┐
│ Luanti server    │ ─────────────────────────────────────────▶ │ Voice relay      │
│ simple_voicechat │ ◀───────────────── status ──────────────── │ routing + tokens │
│ (Lua mod)        │                                            │ WebRTC signaling │
└──────────────────┘                                            └────────┬─────────┘
                                                                         │ WebSocket
                                                                         ▼
                                                              ┌──────────────────┐
                                                              │ Voice panel      │
                                                              │ browser: mic,    │
                                                              │ Opus, 3D audio   │
                                                              └────────┬─────────┘
                                                                       │ WebRTC
                                                                       │ (DTLS-SRTP)
                                                                       ▼
                                                              other voice panels
```

The relay decides **who may hear whom** from the positions the game server sends;
the browser panels only capture speech and render it. Audio flows peer to peer
and never through the relay, so the server stays cheap and the audio path stays
low-latency.

## Quick start

### 1. Run the relay

```bash
cd relay
npm install
cp config.example.json config.json
# edit config.json: set "secret" to a long random string (openssl rand -hex 32)
npm start
```

The relay listens on `http://localhost:8090` by default.

**HTTPS is required for real players.** Browsers only allow microphone access in
a secure context, which means `localhost` or HTTPS. For a remote server, use a
real certificate (for example by putting Caddy or nginx in front of the relay, or
by pointing `tls.cert` / `tls.key` in the config at a certificate you have).
`relay/scripts/make-cert.sh` can create a self-signed one for testing, but every
player would have to trust it first.

### 2. Install the mod

Copy `mods/simple_voicechat` into your Luanti `mods/` directory (or into a game's
`mods/` directory) and enable it. Add this to `minetest.conf`:

```ini
secure.http_mods = simple_voicechat
simple_voicechat.relay_url = https://voice.example.com
simple_voicechat.secret = the-same-secret-as-the-relay
```

`secure.http_mods` is required: the mod talks to the relay over the Luanti HTTP
API, and that API is opt-in per mod.

### 3. Use it

1. In game, type `/voice`.
2. Open the panel URL in a browser, or open the panel and type the six-character
   code it shows.
3. Pick voice activation or push to talk, then talk.

The panel is served by the relay at its root, so the URL in the mod's panel is
the relay address.

For voice **inside** the Luanti window, build the patched client with
`./client/build.sh`, set `voicechat.relay_host` and `voicechat.relay_port` in
`minetest.conf`, and press `F` to talk. `/voice` supplies the one-time token
automatically.

## Commands

| Command | Effect |
| --- | --- |
| `/voice` | Open the panel and show a join code |
| `/voice code` | Request a fresh code (the old one stops working) |
| `/voice invite <player>` | Add a player to your group without the password |
| `/voice status` | Relay state, players on voice, open groups |
| `/voice disable` / `/voice enable` | Opt out of voice chat entirely |
| `/voice admin mute <player>` | Mute a player's outgoing voice (needs `voice_admin`) |
| `/voice admin unmute <player>` | Undo an admin mute |
| `/voice admin kick <player>` | Drop a player from voice chat |
| `/voice admin groups` | List open groups and their members |

Give trusted players the privilege:

```bash
/grant <name> voice_admin
```

## In the voice panel

- **Push to talk** (default `V`, configurable) and **voice activation** with a
  threshold slider and live input meter.
- **Whisper** (hold `X`): your outgoing range drops to the relay's
  `whisper_distance`.
- **Broadcast** (`B`): only shown when the relay sets `broadcast_range > 0`;
  reaches everyone in that radius and ignores groups.
- **Groups**: name, optional password and a type — normal (members hear nearby
  players), open (proximity works both ways) or isolated (group only). Members
  hear each other at any distance; leaving returns you to proximity.
- **Invites**: invite a player into your group from the panel or `/voice invite`.
- **Per-player volume and mute** in the roster, with distance read-out.
- **Device selection**: pick the microphone and, in browsers that support it, the
  speaker output; the choice is remembered.
- **Mic test**: monitor your own input; **speaker test**: a short tone.
- **3D audio**: HRTF panning driven by your in-game position and yaw, with a
  toggle.
- **Recording**: per-player tracks plus a mixed track, downloadable as WebM/Opus,
  when the relay allows recording.
- **API**: `window.SimpleVoiceChat` in the page console.

## Feature parity with Simple Voice Chat

| Simple Voice Chat | Here | Notes |
| --- | --- | --- |
| Push to talk, configurable key | Yes | `F` in the native client; `V` in the browser panel |
| Voice activation, threshold, VAD | Yes | 300 ms hangover |
| Proximity voice | Yes | `max_voice_distance`, server-authoritative |
| Password-protected groups | Yes | scrypt-hashed passwords |
| Group types (normal / open / isolated) | Yes | Same routing rules as SVC |
| Group invites | Yes | `/voice invite <player>` or the panel |
| Whispering | Yes | Directional: reduces only your outgoing range |
| Broadcast | Yes | Enable with `broadcast_range` in the relay config |
| Configurable voice distance | Yes | Relay config, not minetest.conf |
| Individual player volume | Yes | Roster slider |
| Microphone amplification | Yes | Input gain slider |
| Audio device selection | Yes | Microphone and, where supported, speaker pickers |
| Automatic microphone gain | Yes | Adaptive, toggleable |
| Opus codec | Yes | WebRTC negotiates Opus |
| 3D sound | Yes | WebAudio HRTF, toggleable |
| Encryption | Yes | DTLS-SRTP, mandatory in WebRTC |
| Recording with separate tracks | Yes | Per player + mixed, when enabled |
| Mute / admin mute / kick | Yes | `voice_admin` privilege |
| Speaking and group indicators | Yes | HUD text + nametag tint while talking |
| Hide all icons | Yes | "Hide extra interface" in settings |
| Force voice chat | Partial | Visible nag; Luanti cannot force a browser session |
| API | Yes | Lua, HTTP and `window.SimpleVoiceChat` |
| In-game GUI (V key) | Partial | Native PTT and connection state; no group/whisper/broadcast menu yet |
| In-game audio playback | Yes (native fork) | OpenAL 3D sources; the browser panel remains a fallback |
| RNNoise denoising | **No** | Uses the browser's built-in noise suppression |
| OpenAL | Yes (native fork) | WebAudio fallback in the browser panel |
| ModMenu / loader interop | N/A | Not applicable to Luanti |

The remaining gaps are in the native client, not the engine; see
[client/README.md](client/README.md) for the exact list. The browser panel still
has the richer UI and recording.

## Configuration

### Relay (`relay/config.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `host` / `port` | `0.0.0.0` / `8090` | HTTP listen address |
| `voice_udp_host` / `voice_udp_port` | `0.0.0.0` / `8091` | Native client UDP listener |
| `secret` | — | Shared secret with the mod, at least 16 characters |
| `max_voice_distance` | `32` | Hearing range in Luanti nodes (metres) |
| `whisper_distance` | `8` | Outgoing range while whispering |
| `broadcast_range` | `0` | Broadcast radius; `0` disables the key |
| `allow_recording` | `true` | Whether the panel offers recording |
| `groups_enabled` | `true` | Allow group chats |
| `max_group_members` | `20` | Group size cap |
| `sync_timeout` | `15` | Seconds without a game update before sessions drop |
| `token_ttl` | `120` | Join code lifetime in seconds |
| `require_known_player` | `true` | Only issue codes for players in the game |
| `ice_servers` | `[]` | STUN/TURN servers for WebRTC |
| `invert_pan` | `false` | Flip left/right if your yaw convention differs |
| `public_url` | `""` | Base URL used in links (defaults to the request Host) |
| `tls` | `null` | `{ "cert": "...", "key": "..." }` |

Environment overrides: `SVC_HOST`, `SVC_PORT`, `SVC_SECRET`,
`SVC_TLS_CERT`, `SVC_TLS_KEY`, `SVC_PUBLIC_DIR`.

### Mod settings

`simple_voicechat.relay_url`, `simple_voicechat.secret`,
`simple_voicechat.sync_interval` (0.1–2.0 s, default 0.25),
`simple_voicechat.hud`, `simple_voicechat.join_hint`,
`simple_voicechat.nametag_indicators`, `simple_voicechat.force_voice_chat`.

## Security model

- The relay API is authenticated with the shared secret; the mod is the only
  client. Use HTTPS so the secret is not sent in clear text.
- Players never hold the secret. They get a **single-use** token (or a
  6-character code) that expires after `token_ttl`.
- Tokens are bound to a player name and only issued for players the game server
  has reported online (`require_known_player`).
- Audio is peer to peer over WebRTC, which mandates DTLS-SRTP encryption. The
  relay only sees SDP and ICE candidates.
- The panel strips the token from the address bar after joining and ships a
  restrictive Content-Security-Policy. The static file server rejects path
  traversal.
- WebSocket messages and HTTP bodies are size-limited and rate-limited.
- Moderation is enforced by the receiving clients and by routing: a muted player
  is not routed to anyone. Because audio is peer to peer, a modified client could
  in principle ignore its own mute; run voice on a trusted network or add a TURN
  proxy with quotas if that matters to you.

You can bind the relay to `127.0.0.1` and reverse-proxy it if you do not want to
expose Node directly.

## Limits

- The native client has the audio path, but not the full SVC UI yet: groups,
  whisper, broadcast, per-player volume, device selection, automatic gain,
  noise suppression and recording remain relay/browser features. The native
  client currently sends only the speaking flag; self-mute, whisper and
  broadcast exist in the wire protocol but are not bound to keys.
- The patched client is a source patch, not a prebuilt binary. It opens its own
  OpenAL context, so the OS default microphone must be the one you want.
- The relay routes audio but never carries it, so it cannot record or enforce
  mute against a hostile client. Simple Voice Chat's server can, because its
  clients send audio to it.
- Internet players behind symmetric NAT need a TURN server. Set `ice_servers`
  to your TURN endpoint; on a LAN or a public host, direct candidates work.
- Luanti can only show your own voice state in the HUD and tint nametags while
  someone talks. Per-player icons above heads are not possible without engine
  support.

## Testing

```bash
# relay: 46 unit + integration tests (HTTP auth, tokens, routing, groups,
# signaling relay, admin routes, static safety, CSP, native UDP relay)
cd relay && npm test

# mod: loads init.lua under Lua 5.1 against a fake Luanti API
lua tests/lua/mod_test.lua
```

The Lua harness (`tests/lua/harness.lua`) implements the `core.*` calls the mod
uses, so its 27 tests cover command registration, code requests, sync payloads,
HUD/nametag behaviour, opt-out, moderation, invitations and the public API. It
is not a substitute for running the mod in a real Luanti server, and that has
not been done here.

The panel was exercised in Chromium against a live relay with two sessions:
join-code authentication, roster positions, group creation and invites,
self/admin mute routing, admin unmute, group leave and recording (mixed plus
per-player tracks) all worked. The cloud browser could not establish ICE even
for a loopback data channel, so the WebRTC path was verified through SDP
offer/answer exchange, not by hearing audio.

## Layout

```
mods/simple_voicechat/   Luanti server mod (Lua)
relay/                   Node relay: HTTP API, WebRTC signaling, native UDP, panel
relay/public/            Browser voice panel (no framework, no build step)
client/                  Native Luanti client patch, build script and notes
client/patches/          Patch against Luanti 18cbd54
client/README.md         Build and native client limitations
docs/PROTOCOL.md         HTTP + WebSocket + native UDP protocol and routing rules
docs/ENGINE-NOTES.md     Engine boundary and what the native patch implements
tests/lua/               Lua 5.1 test harness for the mod
```

## Credits

Protocol and feature ideas follow
[Simple Voice Chat](https://github.com/henkelmax/simple-voice-chat) by
henkelmax. Luanti API references: [api.luanti.org](https://api.luanti.org/) and
[the modding book](https://rubenwardy.com/minetest_modding_book/).
