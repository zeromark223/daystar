# Daystar

A tiny meeting app that plays like a game: every person is a glowing star or planet
drifting around a shared sun in a 10,000 px disc of space. Move freely, chat, and
listen: whoever creates a room is its host (the sun itself) and chooses who may speak.
The world is drawn entirely in code with PixiJS (no image assets).

## Quick start

Daystar runs on [Bun](https://bun.sh) (1.4.2 or newer); install it first.

```bash
git clone https://github.com/zeromark223/daystar && cd daystar
bun install          # dependencies (Vite, PixiJS, TypeScript)
bun run build        # builds the web client into client/dist
bun start            # http://localhost:3000
```

The built client is not committed, so `bun start` on a fresh clone without
`bun run build` shows an "Almost there" page instead of the game.

## Stack

- **Client:** PixiJS v8 + Vite (TypeScript)
- **Server:** Bun (`Bun.serve`, native WebSockets and topic pub/sub), TypeScript
  executed directly; it also serves the built client. The project is Bun-only
  (runtime, package manager, tests and tooling).
- **Transport:** WebSocket only, binary frames throughout — a schema-driven encoder
  (`shared/src/binary/schema.ts`) lays out every message; see `shared/src/protocol.ts`

## Develop

```bash
bun install
bun run dev          # server on :3000 (watch) + Vite on :5173 (proxies /ws)
```

Open http://localhost:5173 and create a room: you become its host and land on
`/r/<room-id>`. Share that URL to invite others. Add `?debug` to expose the game,
voice player and microphone objects in the console.

### Testing voice from a phone

Browsers only allow the microphone and WebCodecs on secure pages (HTTPS or
`localhost`), so `http://<your-lan-ip>:3000` on a phone gets no voice. Serve HTTPS
with a self-signed certificate instead (standalone mode only):

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=daystar-dev" \
  -addext "subjectAltName=IP:192.168.1.20" -keyout dev-key.pem -out dev-cert.pem
bun run build
TLS_CERT=dev-cert.pem TLS_KEY=dev-key.pem bun start
```

Replace the IP with your machine's LAN IP, open `https://<that-ip>:3000` on the phone
and accept the certificate warning. (Chrome also has the
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` flag for a quick test.)

## Cluster

`bun run cluster` starts an agent (`:3000`) and 4 game servers (`:3001`–`:3004`);
clients ask the agent where to connect, rooms can span servers, and overloaded
servers hand players over. Design, configuration and Coolify setup:
[docs/cluster.md](docs/cluster.md). A one-page overview for non-developers:
[docs/architecture/index.html](docs/architecture/index.html) (open it in a browser). The Docker image runs standalone unless
`CLUSTER_SERVERS` is set.

## Layout

```
shared/src/     protocol, appearances, world rules (used by client and server)
server/src/     game server (main.ts), rooms, agent/, cluster/ (tickets, mesh), supervisor.ts
client/src/     lobby, chat UI, Pixi game (camera, avatars, input)
tools/          load test
```

## The world

- A disc of radius 5,000 px around the sun; players cannot enter the sun (radius 200)
  and slide along it and along the edge (`shared/src/space.ts`).
- Brightness falls off beyond 60% of the radius and reaches zero at the edge, where a
  player is invisible to others (you still see a faint ring around yourself). This is
  visual only: positions are still sent to everyone.
- Appearance: eleven kinds of body (star, planet, ringed planet, comet, moon, gas giant,
  black hole, binary star, pulsar, planet with a moon, UFO) in one of eight colors; one
  byte on the wire. Bodies are painted in code (`client/src/game/bodies.ts`) and
  animated with transforms only; most wear a face that blinks, looks where it goes and
  opens its mouth with the speaker's voice.
- Newcomers appear near someone already in the room, or on a ring around the sun.
- Sky, nebulae, sun, glows and trails are generated at startup (canvas gradients and
  PixiJS graphics); the minimap and wheel / `+` `-` zoom help finding people.
- On touch screens, dragging anywhere brings up a thumbstick under the finger (slower
  near its center); a tap still walks to the tapped point and two fingers pinch to zoom.

## Roles and voice

- **Host:** creates the room (`POST /api/rooms` hands out a host key), is drawn as the
  sun, and taps a player (or uses the People panel) to make them a speaker or a guest.
- **Speakers** (up to 8) and the host can turn their mic on; **guests** listen.
- Voice is Opus (WebCodecs) over the same WebSocket, only while someone is talking,
  relayed inside the 20 Hz snapshot. Details: [docs/voice.md](docs/voice.md).
- Voice works in Chrome and Safari on phones, and Chrome, Edge and Firefox on
  computers (not yet Firefox on Android). It needs HTTPS.

## Audience

- **Reactions:** 👏 ❤️ 😂 😮 🎉 👍 (buttons, or keys 1-6) float up from the player and
  make its face open its mouth. Rate-limited per player and capped at 64 per
  snapshot, they ride the next snapshot like joins and leaves, so a room-wide burst
  of applause costs no extra messages.
- **Raised hands:** guests raise a hand (button or H) to ask for the floor. The host
  sees the hands oldest first in People and invites one to speak or lowers it;
  becoming a speaker lowers it too.
- **Polls you answer by flying:** the host asks a question with 2 to 4 answers, each
  answer becomes a planet on a ring around the sun, and players vote by flying to
  one. The server counts from positions it already has (twice a second, sent only
  when counts change). Only players who moved since the poll started count, so
  nobody votes by spawning inside a planet. The host ends the poll to show the result.
- In cluster mode reactions, hands and polls are mirrored between servers like roles.
- **Tutorial:** a short guided tour the first time someone joins as a guest, becomes a
  speaker or hosts, with a spotlight on each control. Skip or finish it and the
  browser remembers (local storage); ⚙ Settings → Replay tutorial shows it again.

## Capacity

**2,800 CCU stable in one room on one core of a Xeon E5-2680 v4** (a Coolify VM on
Proxmox), with area of interest, using ~200 Mbps of egress. Bots ran on a separate
wired machine over the LAN, through Coolify's Traefik only, with kernel mitigations
off. Scenario: one room, a host and two speakers talking in turns, listeners walking
20% of the time, no chat.

At 2,800: server CPU 68%, event loop p99 37 ms, move p99 100 ms, voice p99 135 ms,
all voice frames delivered. At 3,000-3,200 only the server's event loop passed its
50 ms target (CPU ~75%); what players saw was still fine (move p99 ~100 ms, voice
p99 ~137 ms). The single core is now the limit, not bandwidth; cluster mode spreads a
room over more cores.

| Setup | Stable (all targets met) |
|---|---|
| Internet (Cloudflare), mitigations on (default) | 800 CCU |
| Internet, `mitigations=off` on the Proxmox host and in the VM | 1,000 CCU (limited by the test network) |
| LAN (Traefik only), mitigations off | 1,600 CCU |
| + snapshot groups | 2,200 CCU (limited by the ~740 Mbps test network) |
| + overcharge and area of interest | **2,800 CCU at ~200 Mbps** |

- `mitigations=off` removes protections against Spectre/Meltdown-class attacks:
  only on a host where you trust every VM and container.
- The same load costs the server more over the internet than on a LAN (congested
  paths back up sockets), so size production from internet measurements, and mind
  the proxy: through Cloudflare, new connections started failing with HTTP 502 at
  about 2,000 concurrent sockets.
- Area of interest helps when people spread out; a crowd standing in one spot
  costs what it did before.
- On a faster core the same build goes much further: **~7,000 CCU in one room on one
  core of a Ryzen AI 7 350** (dev laptop, server and bots on the same machine over
  loopback): CPU 65%, event loop p99 40 ms, move p99 85 ms, voice p99 133 ms. Up to
  10,000 what players saw stayed within targets (move p99 134 ms, voice p99 183 ms)
  while the event loop hovered around its 50 ms limit at ~1.2 Gbps out. Test the
  server's own port: the Vite dev server's proxy capped the same run at ~5,000.

### Operating system matters more than the chip

Same build and command (one room, a host and two speakers, 20% walking), server and
bots on the same machine:

| Machine | OS | Stable in one room | At 5,000 players |
|---|---|---|---|
| Ryzen AI 7 350 (laptop) | Linux, native | **~7,000** (9,000 still within targets: CPU 80%, loop p99 46 ms) | CPU 60%, 870 Mbps out, loop p99 31 ms |
| i7-13700K (desktop) | Linux in WSL2 | ~7,000 (CPU 92%, loop p99 47 ms; 9,000 fails at 103% CPU) | CPU 68%, 887 Mbps out, loop p99 37 ms |
| i7-13700K (desktop) | Windows, native | **under 5,000** | CPU 97%, only 215 Mbps out, loop p99 135 ms |

- **Bun on Windows is much slower for this server.** At 5,000 players it saturated
  the core while sending about a quarter of the data Linux sent, roughly 6x the CPU
  per message; past that the server stopped answering. The server's cost is mostly
  socket sends, which Bun (uWebSockets) optimizes for Linux. Host on Linux; use
  Windows for development only.
- **WSL2 is a virtual machine**: better than native Windows, but every socket send
  crosses the virtualization layer and Windows may run its vCPUs on the
  13700K's efficiency cores, so it is not a fair chip comparison (on single-core
  benchmarks the two chips are roughly on par). Under WSL2, raise `ulimit -n` (the
  default stopped the server at ~2,000 sockets) and run the bots inside WSL too:
  connecting from Windows to `localhost` goes through WSL's forwarding relay.
- In virtual machines generally (WSL2, Proxmox), the kernel mitigations inside the
  guest cost the most; see the `mitigations=off` results above.

## Rust port: how much does the language matter?

[`server-rs/`](server-rs/README.md) is the standalone server ported to Rust (tokio):
same protocol, rules and features as of October 2026, no cluster mode. It is kept
as a benchmark and no longer follows the protocol: it predates raised hands,
reactions and polls, so today's client does not work with it. Same laptop (Ryzen AI 7 350,
Linux), same load test (one room, a host and two speakers, 20% walking, area of
interest, 10 Hz per player from 2,000 players), bots on the same machine:

| Players | Bun (TypeScript) | Rust, 1 thread | Rust, 4 threads |
|---|---|---|---|
| 3,000 | CPU 42%, loop p99 17 ms | CPU 35%, loop p99 15 ms | CPU 50%, loop p99 2 ms |
| 5,000 | 59%, 32 ms | 50%, 25 ms | 81%, 2 ms |
| 7,000 | 71%, 48 ms, move p99 86 ms | 58%, 34 ms, move p99 88 ms | 105%, 2 ms, move p99 78 ms |
| 9,000 | 81%, 54 ms: **fails** (event loop) | 71%, 36 ms, move p99 121 ms | 132%, 2 ms, move p99 79 ms |
| 11,000 | fails (move p99 175 ms) | fails (move p99 311 ms) | 157%, 3 ms, move p99 82 ms |
| Memory at 9,000 | 145 MB | 296 MB | 232 MB |
| **Stable** | **~7,000** | **~9,000** | **~11,000+** (then the bots, on the same laptop, give out) |

- **One thread against one thread, Rust uses 15-20% less CPU** for the same load,
  which is worth ~30% more players (7,000 -> 9,000). Not the 2-3x one might expect:
  Bun's heaviest work, writing to thousands of sockets, already runs in native code
  (uWebSockets, C++); Rust saves the JavaScript around it (encoding, area of
  interest, ticks, GC).
- **The real gain is threads.** With 4 threads the room logic stays on one core
  while framing and socket writes spread over the others: the event loop stays at
  ~2 ms and latency barely moves up to 11,000 players. Bun gets there only with
  cluster mode (several processes and the mesh).
- Past ~9,000 players the laptop itself is the limit: the server's thread waits
  for a core (CPU under 80% while the loop lags) because the bots use the rest.
- **On the Coolify VM** (one core of the Xeon E5-2680 v4, over the LAN through
  Traefik, both servers with the same optimizations), one thread each:

  | Run | Bun | Rust, 1 thread |
  |---|---|---|
  | Steps (`--hold 40`) | ~2,500-3,000: 2,000 at 46% CPU; 3,000 fails on the event loop only (54 ms), players' latency fine to ~3,200 | **3,500**: 2,000 at 39% CPU; 3,500 at 71%, loop 47 ms; fails at 4,000 |
  | `--max 5000 --ramp 50`, a row every 5 s | last row meeting every target at **2,250** | last row meeting every target at **2,750** |

  Rust holds ~15-25% more players on the same core and moves more data at the same
  count (427 vs 356 Mbps at 3,000 in the ramp). The fast ramp finds a lower knee
  than steps: bots arriving at 50 per second have not spread out yet (area of
  interest saves less), every join brings a whole-room welcome, and 5-second rows
  catch spikes that longer holds average out. It is the "everyone joins at once"
  case; a slower `--ramp` or steps around the knee give the steady capacity.
- **Why the single thread "stops at ~73% CPU".** Pinned to one core at 11,000
  players, that core was 100% busy: 31% our code, 38% system calls (socket sends,
  receives, epoll) and 31% softirq. The softirq part is the kernel's network
  processing, much of it the bots' receiving side, which on loopback runs on the
  sender's core and is not counted in the process's CPU time. On a real network
  that share moves to the clients. Profiling also showed glibc's `hypot` taking a
  third of the server's time in the area-of-interest checks; squared distances
  (now in both servers) gave the single thread ~25% more throughput.
- Rust uses about twice the memory of Bun here (~25-35 KB per socket: a task, a
  channel and WebSocket buffers per connection, against uWebSockets' compact
  per-socket state).

## The road from 550 to 2,800 CCU

Daystar started as a small Node.js server. Every number below comes from
`tools/loadtest.ts` against the same Coolify VM (one core of a Xeon E5-2680 v4).
The scenario got harder along the way, from rooms of 20 to a single room, and from
chat to a host and two speakers talking, so the real gain is larger than the
numbers suggest.

| Step | Change | Result |
|---|---|---|
| 0 | Node.js + `ws`, a 20 Hz snapshot of every player, binary schema protocol | ~550-600 CCU in rooms of 20 with everyone walking; ~37 µs per sent message on this host (6 µs on a laptop) |
| 1 | Delta snapshots: only players that changed | ~1,000 CCU in rooms of 20 with 20% walking |
| 2 | Bun: native WebSockets and topic pub/sub (one call fans a frame out) | laptop: 5,000 CCU vs ~3,000-4,000 on Node; Coolify: ~1,000 in one room with chat off (~21 µs per message) |
| 3 | Roles and voice; voice rides the snapshots that go out anyway | 800 CCU stable in one room with three people talking, over the internet |
| 4 | `mitigations=off` on the Proxmox host, then in the VM | server CPU -35%; 1,000 CCU end to end, now limited by the test network |
| 5 | Testing over the LAN (Traefik only) | 1,600 CCU; the same load costs less CPU without congested paths |
| 6 | Snapshot groups: each tick serves half the room | 2,200 CCU; at 1,800 players CPU -37%, event loop p99 -60%, egress -43% |
| 7 | Overcharge: the snapshot rate follows the load in 2 Hz steps | rooms keep the highest rate that fits (1,800 players at 14-18 Hz instead of 10) |
| 8 | Area of interest: only players within 1,500 px, with fog on the client | **2,800 CCU at ~200 Mbps**; bandwidth is no longer the limit |

What we learned:

- **Count messages, not bytes.** On this host each send costs ~21 µs (a VM, Docker,
  PTI), so what mattered was sending fewer frames: delta snapshots, voice inside the
  snapshot, one frame per player per tick. Compression did not help (LZ4 saved 0%
  on the packed binary).
- **Measure the tester too.** The first runs hit the laptop's Wi-Fi (~21 MB/s),
  later the LAN (~740 Mbps). When latency rose while the server's CPU and event loop
  stayed flat, the bottleneck was outside the server.
- **One room is quadratic.** Every snapshot carries the 20% who move and goes to
  everyone, so bandwidth grows with N²: from 1,800 to 2,400 players (+33%), egress
  went up 69%. Only area of interest breaks that.
- **Spread the burst.** Event loop latency follows the biggest burst of sends, not
  the average. Serving half the room per tick at twice the tick rate halved the
  event loop p99 for the same per-player rate (local A/B, GC unchanged).
- **Kernel mitigations matter in VMs.** PTI makes every syscall dearer; turning it
  off inside the VM gave most of the 35%.
- **Trade CPU for bandwidth on purpose.** Area of interest roughly doubled the CPU
  per player and cut egress by 45-75%. The core is the limit again, and cluster mode
  (one room over several processes) is the next step.

## Networking

- Every frame is binary: an opcode byte plus a body described by a schema
  (`shared/src/binary/schema.ts`, a port of an older BinaryBuilder/BinaryParser).
  Positions are UInt16 in 1/4 px steps; with its id, motion and age a player costs
  8 bytes in a snapshot.
- Client moves locally (instant response) and sends its position at 20 Hz.
- Server validates speed and the world limits, sends a `correction` if a move is invalid,
  and broadcasts a binary snapshot at 20 Hz when anything changed.
- **Smooth remote players** (`client/src/game/timeline.ts`): each snapshot carries the
  server's time at the tick, and each player the age of its position (when the move
  reached the server), so every position has a server timestamp. Clients draw others
  on the server's timeline, behind by one snapshot interval + one send + the
  measured jitter (95th percentile over 4 s), and adjust that delay as slower or
  faster playback (5-10%), never a jump; a moving player whose next position is late
  keeps going for up to 80 ms. Stamping positions on arrival, as before, made people
  speed up and stall: with 80 ms of network jitter 64% of frames were off by more
  than a quarter, with jumps of 4.5x a frame's move; now 1-2% and 1.1x
  (`tools/smoothness.ts`).
- **Snapshot groups:** from 200 players on one server, a room splits them in two
  groups served on alternate ticks and ticks at 40 Hz, so everyone still gets 20 Hz
  but each tick's burst of sends covers half the room (event loop p99 halved in a
  local A/B at 2,000 players, GC unchanged, about 10% more CPU).
- **Area of interest** (`shared/src/aoi.ts`): players only get the moves of others
  within 1,500 px; the host and speakers are always in view, and the room-wide roster,
  chat and roles are unchanged. The server keeps a 375 px grid and sends one snapshot
  per occupied cell (built from per-player parts encoded once per tick), so each
  player still gets one message per tick. Entering a new cell brings a `view` message
  with everyone in the strip that just came into view, idle players included. Clients
  fade others out between 1,100 and 1,450 px (fog) and show the view radius on the
  minimap. Measured locally (one room, bots spread by random walks), at 1,000 bots and
  20 Hz: 135 Mbps out instead of ~250 (-45%), for 28% of a core instead of 15%. The
  saving grows as more players spread out (about -75% at 3,000); a crowd standing in
  one spot gains nothing.
- **Joins and leaves ride the snapshot:** instead of one `player_joined` /
  `player_left` broadcast per event, a room queues them and appends them to each
  group's next snapshot (a join and a leave in the same tick cancel out). Fifty joins
  per second in a 5,000-player room used to be 250,000 extra sends per second; now
  they add a few bytes to the frames each player gets anyway. A newcomer's welcome
  still goes out at once.
- **Overcharge** (`server/src/overcharge.ts`): when the server runs hot, every room
  sends fewer snapshots per player, 2 Hz at a time (20, 18, ... 10), and climbs back
  when there is room again. The load score is the highest of event loop p99 / 50 ms,
  CPU / one core and, if `EGRESS_BUDGET_MBPS` is set, outgoing traffic / that budget;
  it steps down after 5 s at 0.75 or more, and back up only when the higher rate is
  predicted to stay under 0.65 for 10 s. Rooms of 2,000+ players on one server are
  capped at 10 Hz. The client's drawing delay follows the snapshot rate (see above).
  The capacity figures above were measured before this.
- Rooms live in memory and disappear when the last socket closes; each keeps the
  last 100 chat messages.

## Load testing

```bash
bun tools/loadtest.ts --steps 500,1000,2000 --room-size 20
```

Spawns a server, ramps up bot players that walk non-stop and chat, and prints per
step: server players, CPU, event loop utilization and delay (read from the server's
`/api/health`), snapshot arrival gaps, chat round-trip and bandwidth. `--room-size 0` puts everyone in one
room. `bun tools/loadtest.ts --help` lists all options. (`bun run loadtest …` also works
on Linux and macOS; on Windows call the file directly, since Bun's script shell can
drop flags there.)

`--max` finds the knee faster than steps: bots keep arriving at `--ramp` per second
up to the maximum, then stay `--hold` seconds, with a row every `--report-every`
seconds (default 5) and a closing summary of the last row that met every target:

```bash
bun tools/loadtest.ts --target https://meet.example.com --max 5000 --ramp 50 --hold 60 \
  --report-every 5 --room-size 0 --moving 0.2 --chat-every 0 --speakers 3
```

Both modes also write the rows to `loadtest-logs/<time>-<host>.csv` (git-ignored;
`--log <file>` to choose, `--no-log` to skip), headed by the command, the target and
the start time, so runs can be compared in a spreadsheet.

To test a deployed server from this machine, point it at the public URL. Server
columns come from its `/api/health`; if the server sets `HEALTH_TOKEN`, pass it:

```bash
bun tools/loadtest.ts --target https://meet.example.com --health-token $TOKEN --steps 200,500,1000 --room-size 20
bun tools/loadtest.ts --last               # same options again
bun tools/loadtest.ts --last --hold 60     # same, with one option changed
```

A spawned server runs with `BUN_JSC_logGC` so the `gc/s` and `gc max ms` columns are
filled (they show `-` with `--target`). `tick p99` is the
time a room tick spends encoding and sending its snapshot (the budget at 20 Hz is 50 ms).

Bots are kept cheap so they can share a machine with the server: only one in ten
(`--measure-share`, default 0.1) times its moves, snapshot gaps and voice, the rest
only count frames, and none of them decodes the whole room in `welcome`. At 9,000
bots that cut their CPU per MB received by about 35%.

With server and bots on one machine, the `srv CPU` column understates a busy
server: loopback network processing runs as softirq on the server's core and is not
part of its CPU time (a core can be saturated while the column reads ~70%).

`--last` reads `.loadtest-last.json` (git-ignored; it stores the token in plain text). Instead of `--health-token`, you can put `HEALTH_TOKEN=…` in a
git-ignored `.env` file at the repo root; Bun loads it and the load test uses it.

Bots use rooms named `<room-prefix>-all` / `<room-prefix>-0..n` (default `load`).

`--speakers 3` makes each room a meeting: the load test creates the rooms with
`POST /api/rooms`, the first bot of each room joins as host and promotes two
speakers, and the three hold a conversation in turns with real Opus frames
(`tools/voice/*.ogg`, synthetic speech from espeak-ng). The invite links are printed
so you can join and listen. `voice p50/p99` is the time from the end of a spoken
frame to a bot receiving it through the server (before the client's playout delay);
`voice rx` is the share of expected frames that arrived. `--chat-every 0` turns chat off.

```bash
bun tools/loadtest.ts --target https://meet.example.com --health-token $TOKEN \
  --steps 200,400,600,800 --room-size 0 --moving 0.2 --chat-every 0 --speakers 3
```

By default every bot walks non-stop (worst case). `--moving 0.2` makes each bot walk
20% of the time and stand still (sending nothing) otherwise, closer to a real meeting.
`move p50/p99` is the time from a bot sending a position to seeing it echoed back in
a snapshot, which is the lag other players see; it stays meaningful with idle bots,
unlike snapshot gaps (a room where nobody moves gets no snapshots at all).

## Deploy (Coolify)

Build from the `Dockerfile` (Bun). The container listens on `PORT` (default 3000) and
exposes `GET /healthz` (plain liveness) and `GET /api/health` (JSON load stats: rooms,
players, CPU, event loop, memory, last 5 minutes of 1 s samples). Set `HEALTH_TOKEN`
to require `Authorization: Bearer <token>` on `/api/health` in production. WebSockets go through the normal HTTP proxy on `/ws`.
Set `EGRESS_BUDGET_MBPS` to the outgoing bandwidth the server may use (e.g. a bit under
the link's capacity) so the overcharge lowers snapshot rates before the link saturates.
Set `ROOM_SECRET` (any long random string) so hosts keep their rooms across restarts
(a cluster uses `CLUSTER_SECRET` for this). The microphone needs HTTPS.

## License

Code is released under the [MIT License](LICENSE).
