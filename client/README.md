# Native in-game voice client

This directory contains the **client half** of Simple Voice Chat for Luanti: a
source patch against the Luanti C++ client. It is not a prebuilt binary and it is
not a Minecraft mod.

The server half is the existing `mods/simple_voicechat` plus `relay/`. The relay
already owns tokens, proximity checks, groups and moderation; the client patch
only adds the audio path that a Lua mod cannot provide.

## What the patch adds

- OpenAL capture on a dedicated audio thread, 48 kHz mono, 20 ms frames.
- Opus encoding at 32 kbit/s with in-band FEC and 10 % expected loss.
- A small UDP protocol (`SVL1`) to the relay's native listener. It is separate
  from the browser panel's WebRTC path.
- 3D OpenAL playback: one streaming source per remote speaker, positioned from
  the server's authoritative player positions.
- Push-to-talk on `F` (`keymap_voice`); open-microphone mode with an RMS
  threshold is available by setting `voicechat.push_to_talk = false`.
- Automatic join: `/voice` sends a private `SVC-TOKEN:` chat line that the
  patched client consumes. The line is addressed to one player by the mod, not
  broadcast, and is hidden by the patched client.
- The existing browser panel keeps working for players who do not use the fork.

## Build

The patch is pinned to Luanti commit
`18cbd54dbbc0449b8329dd6fe32bdb387e63bb79` (2026-11-07).

Dependencies (Debian/Ubuntu names):

```bash
sudo apt install build-essential cmake git \
    libopenal-dev libopus-dev libvorbis-dev libogg-dev \
    libfreetype-dev libcurl4-openssl-dev libsqlite3-dev \
    zlib1g-dev libzstd-dev libpng-dev libjpeg-dev libzip-dev
```

The easiest route is the script, which clones the pinned source, applies the
patch and builds a Release client:

```bash
./client/build.sh
```

It writes the source to `client/luanti` and the build to `client/build`. Both are
ignored by Git. To use an existing checkout:

```bash
git clone https://github.com/luanti-org/luanti.git luanti
cd luanti
git checkout 18cbd54dbbc0449b8329dd6fe32bdb387e63bb79
git apply ../client/patches/0001-native-voicechat.patch
cmake -S . -B build \
    -DBUILD_CLIENT=TRUE -DBUILD_SERVER=FALSE \
    -DENABLE_SOUND=TRUE -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc)"
```

Run the resulting `bin/luanti` (or `build/bin/luanti`) instead of your packaged
client. The relay must be reachable over **UDP** on `voice_udp_port` (default
8091); the HTTP port is separate.

## Configure

In `minetest.conf` on the **client**:

```ini
voicechat.enabled = true
voicechat.relay_host = voice.example.com
voicechat.relay_port = 8091
voicechat.push_to_talk = true
keymap_voice = SYSTEM_SCANCODE_9
```

The join token is supplied automatically: type `/voice` in game, and the mod
sends the patched client a private `SVC-TOKEN:` line. The relay consumes the
token on first use, so a code that was already used by the browser panel cannot
be reused by the native client. There is no token setting to edit.

## Controls and status

- Hold `F` to talk in push-to-talk mode.
- Set `voicechat.push_to_talk = false` for voice activation; tune
  `voicechat.voice_activation_threshold` and `voicechat.input_gain`.
- Connection/error messages are written to Luanti's log. The mod's `VOICE` HUD
  still reflects the relay's view of the player.
- There is no native group/whisper/broadcast menu yet. Those features remain in
  the browser panel and are routed by the same relay. The native client sends
  only the speaking flag; self-mute, whisper and broadcast flags exist in the
  wire protocol but are not bound to keys in this first client patch.

## What is not implemented yet

This is the real in-game audio path, not a complete clone of every Simple Voice
Chat screen:

- No native group management, whisper key, broadcast key or per-player volume.
- No native device picker, microphone test, automatic gain or noise suppression.
- No native recording.
- The UDP relay is IPv4; use an IPv4 hostname/address for `voicechat.relay_host`.
- The patch has not been compiled in the cloud workspace used to write it (no
  OpenAL/Opus development headers were installed there). Build it on a desktop
  with a microphone and speakers before relying on it.

The relay's 46 tests (including seven native UDP tests) run with `npm test` in
`relay/`. Those tests cover the wire protocol and routing, not the C++ client.
