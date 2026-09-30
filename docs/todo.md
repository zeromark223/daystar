# TODO

Deferred work, with enough context to pick it up later.

## Snapshot size: delta positions + deflate

Measured on 300 real snapshots from a 1,000-player room (20% moving, ~197 players per
snapshot, 1,381 B on average):

| Layout | Bytes | vs now |
|---|---|---|
| Current (7 B/player) + LZ4 (lz4js) | 1,396 | +1% (and ~240 µs JS decode per frame) |
| Current + deflate-raw L1 / zstd L3 / brotli q5 | 1,415 / 1,312 / 1,267 | +2% / −5% / −8% |
| Delta positions (5 B/player) | 988 | −29% |
| Delta + deflate-raw L1 | 672 | −51% (≈6 µs compress, 4 µs decompress) |

LZ4 is not worth it: the packed binary has almost no repeats. Plan instead:

1. **Safety nets first** (they also fix a risk the current delta-*snapshot* design already has):
   - Close sockets that exceed the backpressure limit instead of letting publish drop
     frames for them (`closeOnBackpressureLimit`); the client reconnects and gets a
     fresh `welcome`.
   - A periodic absolute keyframe (e.g. every 5 s, or a rolling share of players per tick)
     so any drift heals within seconds. Costs ~7% bandwidth in a 1,000-player room.
2. **Delta positions**: entries carry `dx, dy` as int8 in 0.25 px units against the last
   position *broadcast* for that player (a move per tick is at most ~80 units). A spare
   bit in the motion byte marks an absolute entry for big jumps (corrections, migration,
   ~0.8% of entries). Rules: integer wire units on both ends; `welcome` sends the last
   broadcast positions, not the live ones; `player_joined` is always absolute.
3. **deflate-raw level 1** per snapshot (compressed once per room tick), decoded in the
   browser with `DecompressionStream("deflate-raw")` **strictly in order** (a queue).
4. Verification: a randomized test (joins, leaves, moves, jumps, late joiners, migration)
   comparing client reconstruction with server state exactly; a `desync` column in the
   load test (bots check their reconstruction against keyframes; target 0).

Over WebSocket (TCP) nothing is lost or reordered inside a connection; the real risks
are server-side frame drops under backpressure and implementation bugs, both covered
above. An unreliable transport (QUIC datagrams, WebRTC) would need acked baselines instead.

## Chat rides the tick frame

On the Coolify host (Xeon E5-2680 v4, ~21 µs per message vs ~2.5 µs on the dev laptop)
a 1,000-player room holds when chat is off, but with every bot chatting once per 90 s
the loop p99 doubles (800 players: 66 ms with chat, 34 ms without; move p99 989 ms vs
105 ms). Each chat line is its own broadcast to the whole room (~7k extra sends/s at
800 players), and each broadcast is a burst on the event loop that stacks on the tick's.

Plan: queue chat lines per room and send them inside the next tick's frame (snapshot +
chat in one message per player), so a tick costs exactly N sends however chatty the room
is. Chat gains at most 50 ms of latency. Same idea later for joins and leaves.

## Voice follow-ups

- Measure voice with the load test: a `--speakers N` option where some bots send
  60 B frames at 50/s while "talking", to see the cost of a talking room on Coolify.
- A speaker who reconnects comes back as a guest (roles live with the socket). Keep
  the role for a short grace period, keyed by the player's name + a per-tab token.
- If TCP stalls hurt on mobile networks, move voice to a WebRTC SFU (docs/voice.md
  "Why not WebRTC").

## Voice in browsers without WebCodecs

Supported today: Chrome and Safari on phones; Chrome, Edge and Firefox on computers.
Firefox on Android has no WebCodecs audio, so it cannot play or send voice.

Plan: libopus compiled to WebAssembly as a fallback inside the voice worker, loaded
only when `AudioDecoder` / `AudioEncoder` are missing. Same Opus bitstream, so the
server and other clients do not change.

1. Decoding first (most people are guests who only listen): worker falls back to a
   WASM Opus decoder and posts PCM to the same playback worklet.
2. Then encoding, for hosts and speakers on those browsers.
3. Before choosing a library: check it is maintained, license compatible with MIT
   (libopus is BSD), download size (lazy-loaded), and CPU per stream on a phone.
   Test by disabling WebCodecs in headless Chrome, then on a real Firefox Android.

Rejected: MediaRecorder (container chunks of hundreds of ms, still needs a decoder),
raw PCM (5x the bandwidth, two formats on the server), WebRTC just for Firefox.
