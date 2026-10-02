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
- Appearance: star, planet or ringed planet, in one of eight colors; one byte on the wire.
- Newcomers appear near someone already in the room, or on a ring around the sun.
- Sky, nebulae, sun, glows and trails are generated at startup (canvas gradients and
  PixiJS graphics); the minimap and wheel / `+` `-` zoom help finding people.

## Roles and voice

- **Host:** creates the room (`POST /api/rooms` hands out a host key), is drawn as the
  sun, and taps a player (or uses the People panel) to make them a speaker or a guest.
- **Speakers** (up to 8) and the host can turn their mic on; **guests** listen.
- Voice is Opus (WebCodecs) over the same WebSocket, only while someone is talking,
  relayed inside the 20 Hz snapshot. Details: [docs/voice.md](docs/voice.md).
- Voice works in Chrome and Safari on phones, and Chrome, Edge and Firefox on
  computers (not yet Firefox on Android). It needs HTTPS.

## Capacity

Measured on **one core of a Xeon E5-2680 v4** (a Coolify VM on Proxmox), bots on a
separate wired machine. Scenario: one room, a host and two speakers talking in turns,
listeners walking 20% of the time, no chat.

| Kernel mitigations | Stable (all targets met) | Server at 1,400 in one room |
|---|---|---|
| on (default) | **800 CCU** (CPU 44%, event loop p99 36 ms, move p99 109 ms, voice p99 126 ms) | CPU 75%, loop p99 58 ms (over the 50 ms target) |
| `mitigations=off` on the Proxmox host and in the VM | **1,000 CCU** end to end (1,200 at the edge of the p99 targets) | CPU 53%, loop p99 45 ms |

- Turning the mitigations off cut the server's CPU by about 35% at every step, most of
  it from the VM's own kernel (PTI makes each socket send's syscall more expensive).
  It removes protections against Spectre/Meltdown-class attacks: only do it on a host
  where you trust every VM and container.
- With mitigations off, the end-to-end limit came from the test network, not the
  server: inbound traffic topped out at ~60 MB/s (~480 Mbit/s) whatever the server
  load, and two testers on the same home connection added nothing. The server itself
  held ~2,000 players across two rooms at 69% CPU with a 34 ms loop p99, before the
  proxy in front of it (Cloudflare / Traefik) started answering 502.
- **Estimate** (not measured), with enough bandwidth: about **1,400-1,500 CCU stable in
  one room** (ceiling ~1,700, needing ~70-90 MB/s out), or ~1,800 in rooms of ~100.
  A single room costs more per player because every snapshot carries the 20% who
  move, sent to everyone.
- Voice adds almost nothing on the server: frames ride the snapshots that go out anyway.
- The cluster mode spreads a room over more processes and cores.

## Networking

- Every frame is binary: an opcode byte plus a body described by a schema
  (`shared/src/binary/schema.ts`, a port of an older BinaryBuilder/BinaryParser).
  Positions are UInt16 in 1/20 px steps, so a snapshot costs 7 bytes per player.
- Client moves locally (instant response) and sends its position at 20 Hz.
- Server validates speed and the world limits, sends a `correction` if a move is invalid,
  and broadcasts a binary snapshot at 20 Hz when anything changed.
- Other players are rendered 100 ms in the past and interpolated between snapshots.
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
Set `ROOM_SECRET` (any long random string) so hosts keep their rooms across restarts
(a cluster uses `CLUSTER_SECRET` for this). The microphone needs HTTPS.

## License

Code is released under the [MIT License](LICENSE).
