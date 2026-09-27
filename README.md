# Daystar

A tiny meeting app that plays like a game: every person is a glowing star or planet
drifting around a shared sun in a 10,000 px disc of space. Move freely and chat; the
world is drawn entirely in code with PixiJS (no image assets). Voice chat comes later.

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

Open http://localhost:5173 — you get redirected to a random room (`/r/<room-id>`).
Share the URL to invite others. Add `?debug` to expose the game object in the console.


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

`--last` reads `.loadtest-last.json` (git-ignored; it stores the token in plain text).

Bots use rooms named `<room-prefix>-all` / `<room-prefix>-0..n` (default `load`).

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

## License

Code is released under the [MIT License](LICENSE).
