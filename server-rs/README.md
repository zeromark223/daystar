# daystar-rs

The standalone Daystar game server ported to Rust, to compare languages on the
same workload. It speaks the same binary protocol as `server/src/` (golden tests
against frames produced by the TypeScript encoder), serves the same web client,
and implements the same rules: rooms and host keys, roles and the speaker limit,
voice relay with idle batching, chat, move validation, snapshot groups, the
overcharge controller and area of interest. Not ported: cluster mode (agent,
mesh, migration) and the A/B fixed schedules.

```bash
bun run build                                   # the web client, as for the Bun server
cargo run --release --manifest-path server-rs/Cargo.toml          # 1 thread
RS_THREADS=0 cargo run --release --manifest-path server-rs/Cargo.toml   # all cores
cargo test --release --manifest-path server-rs/Cargo.toml
bun server-rs/fixtures/gen.ts                   # regenerate the protocol fixtures
```

Environment: `PORT` (3000), `HOST` (0.0.0.0), `RS_THREADS` (1; 0 = all cores),
`ROOM_SECRET`, `HEALTH_TOKEN`, `EGRESS_BUDGET_MBPS`, `CLIENT_DIR` (client/dist).
`GET /api/health` has the same shape as the Bun server's, so `tools/loadtest.ts`
works unchanged (`--target http://localhost:3000`).

Every player is a socket, so a file descriptor. On Linux and macOS the server raises
its soft limit (`ulimit -n`, often 1024) to the hard limit at startup, like Bun, and
warns when that is still under 20,000; raise the hard limit (`ulimit -Hn`,
`/etc/security/limits.conf`) for bigger rooms. The load test's bots need the same.

## Docker and Coolify

`Dockerfile.rust` (at the repository root, because the build also needs `client/`
and `shared/`) builds the web client (Bun) and the server (Rust) into a ~120 MB
image:

```bash
docker build -f Dockerfile.rust -t daystar-rs .
docker run -p 3000:3000 -e ROOM_SECRET=... -e HEALTH_TOKEN=... daystar-rs
```

On Coolify: a new application from this repository with the **Dockerfile** build
pack, base directory `/` and Dockerfile location `/Dockerfile.rust`, port 3000.
Set `ROOM_SECRET`, `HEALTH_TOKEN`, and `RS_THREADS` (1 to compare with the Bun
server, 0 for every core of the VM); `EGRESS_BUDGET_MBPS` as for the Bun server.
The image's health check runs `daystar-rs healthcheck` (GET /healthz), and the
same `tools/loadtest.ts --target https://...` command tests it.

## Design

- **One task per room** owns all of its state (no locks). Connections send it
  events over a channel; it drains them in batches and ticks on its own clock.
- **One writer task per connection.** A room encodes a snapshot once into `Bytes`
  (reference-counted, no copies) and pushes it into each recipient's outbox; the
  writer sends everything queued, then flushes once. A full outbox drops frames,
  like Bun's backpressure limit.
- `RS_THREADS=1` runs everything on a tokio `current_thread` runtime, the fair
  comparison with Bun's single JavaScript thread. More threads spread the
  per-socket work (framing, syscalls) over cores; the room logic stays on one.

## Things that mattered

- `TCP_NODELAY` on every socket (uWebSockets sets it): without it Nagle held
  small frames and added ~13 ms to the median move latency.
- Draining queued events in a batch instead of one `select!` per event: the
  first version fell behind at 9,000 players while its CPU was not even busy.
- Not yielding between those batches: on a single thread a room that yields waits
  behind thousands of socket tasks, and at 9,000 players joins and ticks stalled
  (snapshots 600 ms apart). The writers were never the problem: `/api/health`
  reports `droppedFrames` (outbox full) and `outboxAvg` (frames waiting per send),
  and both stayed near zero.
- Small WebSocket buffers, and **fragmenting frames above 8 KB**: the library
  keeps each socket's write buffer at the size of the largest frame it ever
  wrote, and `welcome` lists the whole room, so unfragmented welcomes cost
  ~N²/2 x 25 B of memory (2-3 GB at 13,000 players). Now ~25 KB per socket.

## Results

See "Rust port" in the main README.
