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
