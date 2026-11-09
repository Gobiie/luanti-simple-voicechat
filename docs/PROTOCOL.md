# Protocol (v1)

Three parties:

- **Game server** — the `simple_voicechat` mod. Knows who is online and where they
  are. Never sees or carries audio.
- **Relay** — Node process. Issues join credentials, decides who may hear whom,
  and brokers WebRTC signaling. Never sees or carries audio.
- **Voice panel** — browser tab. Captures the microphone, encodes with Opus
  (WebRTC), renders 3D audio. Never talks to the game server.

## Authentication

Two separate credentials:

1. **Shared secret** — between the mod and the relay, sent as
   `Authorization: Bearer <secret>`. Set in `minetest.conf` and the relay config.
   Always put TLS in front of the relay when it is not on loopback.
2. **Join grant** — a single-use token or 6-character code, issued to a player,
   bound to their player name and expiring after `token_ttl` seconds (default
   120). The browser exchanges it for a session.

Grants are single-use: consuming one revokes the other form and any previous grant
for the same player.

## HTTP control plane

All endpoints except `/health` require the Bearer secret and `POST` with a JSON
body. Bodies are capped at 256 KiB.

### `GET /health`

No authentication. Useful for a load balancer.

```json
{ "ok": true, "players": 3, "sessions": 2, "groups": 1, "last_sync_ms_ago": 180 }
```

### `POST /api/v1/token`

```json
{ "player": "alice" }
```

Returns:

```json
{
  "token": "3Yk... (43 chars)",
  "code": "K7Q2M9",
  "expires_in": 120,
  "url": "https://voice.example.com/?t=3Yk..."
}
```

`409` when `require_known_player` is on and the player is not in the last sync.
`400` for a missing or malformed name. Issuing a grant invalidates the player's
previous one.

### `POST /api/v1/sync`

The complete player snapshot, sent every `sync_interval` (default 0.25 s). It is
idempotent: anything absent is treated as "left the game".

```json
{
  "players": [
    { "name": "alice", "pos": [12.5, 16.0, -4.25], "yaw": 1.57, "voice": true }
  ]
}
```

Returns the relay's view, which the mod uses for HUD and chat output:

```json
{
  "ok": true,
  "players": {
    "alice": { "connected": true, "group": "hunters", "admin_muted": false, "speaking": false, "broadcasting": false }
  },
  "max_voice_distance": 32,
  "whisper_distance": 8,
  "broadcast_range": 0,
  "allow_recording": true
}
```

### `POST /api/v1/admin/mute`

```json
{ "player": "alice", "muted": true }
```

`404` if the player is unknown to the relay.

### `POST /api/v1/admin/kick`

```json
{ "player": "alice", "reason": "optional" }
```

Closes the player's voice session with WebSocket code `4001`.

### `POST /api/v1/admin/groups`

```json
{ "groups": [ { "name": "hunters", "type": "normal", "members": ["alice"], "locked": false } ] }
```

### `POST /api/v1/admin/invite`

Adds a player to the inviter's group without the password, backing
`/voice invite <player>`.

```json
{ "from": "alice", "player": "bob" }
```

Returns `{ "ok": true, "group": { ... } }`. `409` when the inviter is not in a
group, the target has no voice session, or the group is full.

Any other `/api/*` path returns `404` JSON.

## WebSocket

Endpoint: `GET /ws` (upgrade). Frames are JSON text, capped at 128 KiB and rate
limited to 200 messages per second per connection. A connection that has not
authenticated within 10 s is closed with `4003`.

### Client → relay

| Message | Fields | Meaning |
| --- | --- | --- |
| `auth` | `token` | Exchange a token or code for a session. First message. |
| `group.join` | `name`, `password`, `groupType` | Create or join a group; `groupType` is `normal`, `open` or `isolated` (ignored when joining an existing group) |
| `group.leave` | — | Return to proximity |
| `group.invite` | `player` | Add a player to your current group without the password |
| `self_mute` | `muted` | Stop sending your own audio |
| `whisper` | `on` | Reduce your outgoing range |
| `broadcast` | `on` | Use the broadcast range (if enabled) |
| `speaking` | `on` | Local VAD/PTT state, for indicators |
| `signal` | `to`, `data` | Opaque WebRTC SDP or ICE payload for a linked peer |
| `ping` | `t` | Round-trip measurement |

### Relay → client

| Message | Fields | Meaning |
| --- | --- | --- |
| `welcome` | `you`, `config` | Session id and limits: distances, `ice_servers`, `invert_pan`, `groups_enabled`, `allow_recording` |
| `positions` | `players[]` | At sync rate: `id`, `name`, `pos`, `yaw`, `group`, `speaking`, `self_muted`, `whispering`, `broadcasting` |
| `connect` | `peer`, `initiator` | Open a peer connection; exactly one side gets `initiator: true` |
| `link` | `peer`, `hear` | Whether you should hear that peer; may change without reconnecting |
| `disconnect` | `peer` | Tear the peer connection down |
| `peer.left` | `peer` | Player disconnected entirely |
| `signal` | `from`, `data` | Forwarded WebRTC payload |
| `group` | `group` or `null` | Current group: `{ name, type, members[], locked }` |
| `notice` | `message` | Informational message for the player (for example, an invite) |
| `speaking` | `id`, `on` | Someone started/stopped talking |
| `self_mute` | `muted` | Server ack |
| `broadcast` | `on` | Server ack |
| `admin_mute` | `muted` | An admin changed your ability to speak |
| `error` | `message` | Recoverable protocol error |
| `pong` | `t` | Echo of `ping` |

`connect` is always sent before any `signal` for that pair, so the answerer has a
peer object ready when the offer arrives. The initiator is chosen by comparing
session ids, so both sides agree without a second round trip.

## Routing rules

The relay recomputes the whole graph after every sync, group change, whisper,
mute or session event. `canHear(listener, speaker)`:

```
if listener == speaker                     → no
if listener or speaker not in the game     → no
if either player disabled voice            → no
if speaker self-muted or admin-muted       → no
if speaker broadcasting and range > 0      → distance ≤ broadcast_range
if both in the same group                  → yes (any distance)
if speaker in a normal or isolated group   → no (group audio stays inside)
if listener in an isolated group           → no
if both are in different groups            → no
otherwise                                  → distance ≤ speaker's range
                                             (whisper_distance if whispering,
                                              else max_voice_distance)
```

Consequences worth knowing:

- **Hearing is directional.** Only the speaker's range and whisper state matter
  for the listener's ability to hear them. A link stays up while *either*
  direction is audible, and each side has its own `hear` flag.
- **Group types match Simple Voice Chat.** `normal`: members hear nearby players,
  but nearby players do not hear the group. `open`: proximity crosses the group
  boundary both ways. `isolated`: nothing crosses at any distance. Members always
  hear each other regardless of distance.
- **Broadcast** widens only the broadcaster's outgoing radius and bypasses group
  isolation.
- **Admin mute is routing.** A muted player produces no audible direction, so
  nobody is connected to them for speech (they may still hear others).

Distances are in Luanti nodes; one node is one metre.

## Lifecycle

- A sync that has not arrived for `sync_timeout` seconds drops every session
  ("lost connection to the game server"), so a crashed game server cannot leave
  stale audio routing behind.
- Re-authenticating the same player closes the older session with `4002`.
- A player who disables voice, or disappears from the snapshot, is closed with
  `4001`.
- Groups are deleted when their last member leaves.

## Versioning

Paths are versioned (`/api/v1/...`); WebSocket messages are not, so a protocol
change should bump the major version and be negotiated through `welcome` if
needed.
