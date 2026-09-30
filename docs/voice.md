# Roles and voice

## Roles

| Role | Who | Can |
|---|---|---|
| **Host** | whoever created the room | is drawn as the sun at the center (does not move), talks, chooses speakers |
| **Speaker** | chosen by the host (at most 8) | talks |
| **Guest** | everyone else (the default) | listens, chats, moves |

### Creating a room and the host key

- The home page (`/`) creates a room: `POST /api/rooms` returns `{ room, hostKey }`.
  The **server** picks the room id (e.g. `golden-comet-k3x9q2`), so nobody can ask
  for the key of a room that already exists.
- `hostKey = HMAC-SHA256(secret, "host:" + room)`, truncated. Nothing is stored: any
  server holding the secret can check a key. The secret is `CLUSTER_SECRET` in a
  cluster (agent and servers already share it) and `ROOM_SECRET` standalone. Without
  it a random secret is generated at startup and hosts lose their rooms on restart.
- The browser keeps the key in `localStorage` (`daystar:host:<room>`) and sends it in
  `join`. The invite link is just `/r/<room>`, without the key.
- Rooms opened by typing any `/r/<id>` still work; they have no host (and so no voice).
- **One host at a time:** a second tab presenting the key becomes the host; the first
  one turns into a guest and is moved out of the sun (`correction` + `role`).
- When the host leaves, the speakers keep their role and can still talk, but nobody can
  change speakers until the host is back.

### Protocol

- `PlayerInfo.role` (one byte) in `welcome`, `player_joined` and the mesh.
- Client → server `set_role { id, role: speaker | guest }`, accepted from the host only.
- Server → client `role { id, role }` to everyone in the room.
- A speaker who reconnects (new `join`) comes back as a guest; a migrating one keeps
  the role (it travels in the handoff state). The host always comes back as host
  (it presents the key again).

### Cluster

Roles follow the existing ownership rule: the server holding a player's socket owns its
role.

- Host on s1 picks a player owned by s2 → s1 sends mesh `set_role` to s2 → s2 applies
  it, tells its clients and sends `role` to every interested peer.
- A new host tab dethrones the old host the same way (`set_role guest` to its owner).
- The speaker limit is checked by the host's server against its view of the room
  (eventually consistent; a race can briefly allow one extra speaker).

## Voice

Plain WebSocket, no WebRTC: the audio goes through the same connection and the same
tick as positions.

```
mic ─► AudioWorklet (20 ms frames, 48 kHz mono) ─► voice gate ─► WebCodecs Opus 24 kbps
    ─► WS "voice {seq, data}" ─► server (role check, rate limit, queue)
    ─► next tick: snapshot { players, voice[] } to everyone in the room (and mesh "voice")
    ─► WebCodecs Opus decoder per speaker ─► playout buffer (120 ms) ─► speakers
```

- **Capture:** `getUserMedia` with echo cancellation, noise suppression and auto gain.
  An AudioWorklet cuts the signal into 20 ms frames.
- **Voice gate:** only frames while someone is talking are encoded and sent (RMS above
  a threshold, 400 ms hangover, 60 ms pre-roll so the first syllable is kept). Silent
  speakers cost nothing, like idle players.
- **Relay:** the server drops frames from guests, frames over 512 B, and anything above
  8 KB/s per speaker (token bucket). Frames are queued and sent **inside the next
  snapshot**, so a room with people talking costs exactly one frame per listener per
  tick, however many speakers there are. Latency: up to one tick (50 ms), plus one
  more across the mesh.
- **Playback:** one decoder per speaker; each decoded frame is scheduled right after the
  previous one, 120 ms behind real time. Running dry (a pause) or more than 500 ms
  behind restarts at 120 ms. The speaking glow (speaker ring, or the sun for the host)
  follows the decoded level.
- **Browsers:** needs WebCodecs `AudioEncoder`/`AudioDecoder` with Opus (recent Chrome,
  Edge, Firefox; Safari's support is not verified) and HTTPS (or localhost) for the
  microphone. Unsupported browsers see a message and can still chat.
- **Audio unlock:** the AudioContext starts inside the Join / Create click, the one
  moment browsers allow it.

### Cost

One speaker talking: ~50 frames/s × ~60 B up to the server. Down: the frames ride the
snapshot, adding ~2.5 frames × ~65 B ≈ 160 B per tick per listener while they talk
(~3.2 KB/s, 26 kbps). A 1,000-listener room with one speaker is ~3.2 MB/s extra egress,
and the message count only grows when the room was otherwise idle (a talking speaker
makes every tick send, like a moving player).

### Why not WebRTC (for now)

WebRTC through an SFU (LiveKit, mediasoup) gives UDP, congestion control and a proper
jitter buffer, but needs a separate service and open UDP ports. Over TCP a lossy
network turns into stalls rather than small gaps. If quality on mobile networks or
scale becomes a problem, move voice to an SFU and keep roles and permissions here
(the server would hand out SFU tokens that allow publishing only to host and speakers).
