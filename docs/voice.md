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

Plain WebSocket, no WebRTC: the audio goes through the same connection as positions.

```
mic ─► capture worklet (20 ms frames, 48 kHz mono) ─► voice worker: gate + Opus 24 kbps
    ─► main: WS "voice {seq, data}" ─► server (role check, rate limit, queue)
    ─► snapshot { players, voice[] } to the room (and mesh "voice" every tick)
    ─► main ─► voice worker: Opus decoder per speaker ─► playback worklet: adaptive delay, mix
```

### Threads

Voice must not depend on the main thread, which also renders the game: in a test
where the page only managed 8 frames per second, decoding on the main thread
delivered 8 audio frames per second (50 needed) because every decoder callback waited
for a render. So:

- a **capture worklet** (audio thread) posts 20 ms frames straight to the **voice
  worker**, which runs the gate and the Opus encoder; encoded frames reach the main
  thread in batches with one message in flight at a time (a busy main thread gets
  bigger batches, never a backlog);
- the main thread forwards each server message's frames to the worker in one post;
  the worker decodes and posts PCM straight to the **playback worklet** (audio
  thread), which schedules, mixes and reports speaking levels a few times a second.

With the page rendering at 5-7 fps, playback kept up at ~50 frames per second.

### Sending

- **Capture:** `getUserMedia` with echo cancellation, noise suppression and auto gain.
- **Voice gate:** only frames while someone is talking are encoded and sent (RMS above
  a threshold, 400 ms hangover, 60 ms pre-roll so the first syllable is kept). Silent
  speakers cost nothing, like idle players.
- **seq = microphone time:** a frame's seq is its index in 20 ms steps of mic time,
  counted even while the gate is closed or muted, so a jump in seq tells listeners a
  new talk spurt started (rather than a stall).

### Relay (server)

- Drops frames from guests, frames over 512 B, and anything above 8 KB/s per speaker
  (token bucket).
- **Rides the snapshot when there is one:** in a tick where someone moved, the queued
  frames go out inside that snapshot, costing no extra send.
- **Idle rooms batch to 100 ms:** when nobody moves, frames wait until the oldest is
  100 ms old (`VOICE_FLUSH_MS`) and go out alone, so a listening room gets 10 frames
  per second per listener instead of 20. Never more sends than one per tick.
- Mesh peers get local frames every tick (few peers; the receiving server batches again).

### Playback: adaptive delay (`client/src/voice/playout.ts`)

Each speaker is played `target` behind the arrival of the first frame of a talk spurt:

- an underrun in the middle of a spurt (the queue ran dry) raises the target by 40 ms;
- if, over 8 s, the queue never dropped below 50 ms when frames arrived, the target
  shrinks by up to 10 ms;
- changes apply at the start of the next spurt, so speech is never stretched or cut;
- bounds 80-400 ms, start 150 ms; more than 1 s queued (a backlog after a stall) and
  newer frames are dropped.

Simulated (see `playout.test.ts`): a clean network settles at 80 ms with 50 ms bursts
and ~110 ms with 100 ms bursts, gap-free; 0-180 ms jitter settles near 200 ms with
about one gap per two minutes; 3% of bursts stalled by 300 ms push it to ~380 ms.

Mouth-to-ear latency on a good network: ~25 ms capture and encode, ~30 ms up, 0-50
(or 0-100 in idle rooms) waiting for the flush, ~30 ms down, 80-110 ms playout, ~20 ms
output: roughly 200-300 ms.

### Browsers

WebCodecs `AudioEncoder`/`AudioDecoder` with Opus (recent Chrome, Edge, Firefox;
Safari not verified), in a worker, plus AudioWorklet; HTTPS (or localhost) for the
microphone. Unsupported browsers see a message and can still chat. The AudioContext
starts inside the Join / Create click, the one moment browsers allow it.

### Cost

One speaker talking: ~50 frames/s × ~60 B up to the server. Down, per listener: ~165 B
more per snapshot (2.5 frames × 66 B), ~3.3 KB/s (26 kbps). A 1,000-listener room
with one speaker is ~3.3 MB/s extra egress. Messages: unchanged while people move;
10 per second per listener in an otherwise idle room.

### Why not WebRTC (for now)

WebRTC through an SFU (LiveKit, mediasoup) gives UDP, congestion control and a proper
jitter buffer, but needs a separate service and open UDP ports. Over TCP a lossy
network turns into stalls rather than small gaps. If quality on mobile networks or
scale becomes a problem, move voice to an SFU and keep roles and permissions here
(the server would hand out SFU tokens that allow publishing only to host and speakers).
