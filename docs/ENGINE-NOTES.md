# What a true in-game version needs

The server mod and relay sit on Luanti's Lua API, which cannot capture a
microphone. The native client patch in `client/` supplies that missing engine
half. This document describes the boundary and records what the patch does and
does not cover.

- Mods run **server-side**. `doc/lua_api.md` states that mods are contained and
  run solely on the server.
- The **client-side modding API (CSM)** is experimental and unstable, is disabled
  by default on most servers (`csm_restriction_flags = 62` includes
  `LOAD_CLIENT_MODS`), and deliberately has no file, process or socket access.
  A request to allow trusted client APIs for a Mumble positional-audio mod was
  closed as "won't add" ([luanti-org/luanti#10755](https://github.com/luanti-org/luanti/issues/10755)).
- There is **no microphone capture API at all**, and no audio output stream that
  Lua can position per player: `core.sound_play` plays a sound file, not a live
  stream.
- There is **no UDP or raw socket API** for mods; the HTTP API is request/
  response and runs through curl.
- Server-sent client-side mods (SSCSM), which would let a server ship a client
  GUI, are planned but not implemented.

The engine's own limitations page says the same thing:
<https://docs.luanti.org/for-creators/limitations/>.

## The five missing primitives

To make `/voice` open an in-game window and have voice come out of the game's
OpenAL output, the engine would need:

1. **Audio capture.** An API (or a C++ side channel) exposing a mono PCM stream
   from the default input device, with device enumeration and echo cancellation.
   This is the largest piece and has privacy implications: it must require an
   explicit per-client opt-in, never be reachable from a server-sent mod, and be
   unavailable to CSM by default.

2. **Live audio playback with per-source spatialisation.** Not `sound_play`:
   a persistent source per remote speaker with position, gain, and a callback to
   feed decoded PCM. OpenAL already provides the primitives
   (`alBufferData`/`alSourcei` streaming, `AL_POSITION`, `AL_GAIN`); the engine
   only needs to expose a thin wrapper.

3. **Opus encode/decode.** Bundle libopus (it is small and permissively
   licensed) and expose `encode`/`decode` on 20 ms frames, or hand the codec to
   a helper process. Doing this in Lua via a C module would break the sandbox
   model.

4. **A real-time transport.** The engine could carry voice on its own UDP
   connection as a new packet type, or expose a constrained socket API limited to
   a configured host/port. A Lua-level socket is not acceptable: a mod could
   bypass the sandbox entirely.

5. **An in-game client UI.** Either SSCSM or an engine-provided voice menu with
   keybinds (PTT, whisper, group, mute) that does not depend on the generic
   formspec round trip. The current API cannot add keybinds either, so PTT would
   have to reuse an existing control.

## What the native patch implements

`client/patches/0001-native-voicechat.patch` is the minimal patch shape below,
applied to Luanti `18cbd54dbbc0449b8329dd6fe32bdb387e63bb79`:

- OpenAL capture and streaming playback on a dedicated audio thread.
- Opus 48 kHz mono, 20 ms frames.
- A native UDP transport to the relay (`relay/src/voiceudp.js`).
- A `keymap_voice` push-to-talk key and a private `/voice` token handoff.
- 3D positions from the server's authoritative player state; the relay still
  decides who may hear whom.

The patch does **not** add native group management, whisper/broadcast keys,
per-player volume, device selection, automatic gain, noise suppression or
recording. Those remain browser-panel features.

## The patch shape

The smallest change that would make this project native:

```
client                                server
  mic -> opus enc -> UDP  <────────>  relay/voice server (as here)
  opus dec -> alSource    <────────>  routing decisions (already in relay/src/voice.js)
  voice UI  <───────────────────────  positions + permissions (already in the mod)
```

The existing relay and routing logic carry over unchanged: only the panel's
capture/playback moves into the client. The mod's HTTP contract would stay the
same, which is why `VoiceState` is a standalone module with no Node-specific
dependencies.

## Why not fake it in-game?

- **Sound files cannot carry live voice.** `core.sound_play` takes a registered
  sound name; repeatedly registering and playing short clips would add hundreds
  of milliseconds of latency and leak audio into the media cache.
- **HUD elements are screen-space.** They cannot track another player's head, so
  speaking icons above players are impossible; this project tints nametags while
  someone speaks as the closest honest substitute.
- **CSM cannot be shipped by a server.** Requiring every player to install a
  client mod, enable client modding and add a `mods.conf` entry is not something
  a server admin can mandate, and CSM still could not capture a microphone.

## Building the patch

See [../client/README.md](../client/README.md). The cloud workspace used to author
this patch had no OpenAL/Opus development headers, so the C++ side has not been
compiled there; only the relay's 46 tests were run.

## References

- Luanti limitations: <https://docs.luanti.org/for-creators/limitations/>
- Client Lua API (experimental, no audio): <https://github.com/luanti-org/luanti/blob/master/doc/client_lua_api.md>
- Mod channels (control messages only): <https://docs.luanti.org/for-creators/api/modchannels/>
- HTTP API: <https://docs.luanti.org/for-creators/api/http-api/>
- Voice chat on servers issue: <https://github.com/luanti-org/luanti/issues/10847>
- Trusted client APIs request (declined): <https://github.com/luanti-org/luanti/issues/10755>
- Simple Voice Chat: <https://github.com/henkelmax/simple-voice-chat>
