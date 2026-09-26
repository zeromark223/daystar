# Cute Meeting

A tiny meeting app that plays like a game: pick an animal, walk around a pixel-art
ruin with everyone else in the room, and chat. Voice chat comes later.

- **Client:** PixiJS v8 + Vite (TypeScript)
- **Server:** runs on Node 24 (`ws`), Bun or Deno (their native WebSocket servers),
  TypeScript executed directly, and serves the built client
- **Transport:** WebSocket only, binary frames throughout — a schema-driven encoder
  (`shared/src/binary/schema.ts`) lays out every message; see `shared/src/protocol.ts`

## Develop

```bash
npm install
npm run dev          # server on :3000 (watch) + Vite on :5173 (proxies /ws)
```

Open http://localhost:5173 — you get redirected to a random room (`/r/<room-id>`).
Share the URL to invite others. Add `?debug` to see collision cells.

### Collision editor

Open a room with `?edit` (e.g. `/r/my-room?edit`). The game plays as usual, plus a
toolbar:

- **Draw** (`B`) paints blocked cells, **Erase** (`E`) paints walkable cells; click
  the active tool again to go back to tap-to-move. Brush size 1×1 to 8×8 cells.
- **Undo** (`Ctrl+Z`) reverts the last stroke.
- Edits apply to your own movement immediately; **Save** sends them to the server,
  which updates every room in memory and rewrites
  `client/public/assets/collision.txt` (commit that file).

Saving is enabled unless `NODE_ENV=production`; override with `MAP_EDITOR=1` or `0`.

```bash
npm test             # protocol + collision unit tests
npm run typecheck
npm run build && npm start   # production mode on :3000
```

### Runtimes

The server core (`server/src/app.ts`, `room.ts`) is runtime-independent; each
runtime has a thin entry point with its own HTTP and WebSocket server:

| Runtime | Entry | Start | Docker |
|---|---|---|---|
| Node 24 + `ws` | `server/src/index.ts` | `npm start` | `Dockerfile` |
| Bun 1.4 (`Bun.serve`) | `server/src/bun.ts` | `npm run start:bun` | `Dockerfile.bun` |
| Deno 2.9 (`Deno.serve`) | `server/src/deno.ts` | `npm run start:deno` | `Dockerfile.deno` |

Bun and Deno are fetched by `npx` on first use (pinned versions) rather than being
devDependencies, because Deno's npm installer fails on Alpine (musl) builds.

## Layout

```
shared/src/     protocol, character definitions, collision (used by client and server)
server/src/     HTTP static server, WebSocket rooms
client/src/     lobby, chat UI, Pixi game (camera, avatars, input)
client/public/  generated game assets (spritesheets, map)
assets/         raw source art (not shipped)
tools/          asset pipeline scripts (Python + Pillow)
```

## Assets

- `python3 tools/build_sprites.py` packs `assets/animal/<Animal>/<anim>/<dir>/*.png`
  into one Pixi spritesheet per character with `idle_<dir>` and `run_<dir>`
  animations. Only the deer has a real run cycle; the others reuse walk played faster.
- `python3 tools/gen_collision.py [overlay.png]` derives the first-pass walkability
  grid in `client/public/assets/collision.txt` from the map colors, plus hand-placed
  polygons for stairs and passages (`WALKABLE_OVERRIDES`). Re-running it overwrites
  edits made in the collision editor.

## Networking

- Every frame is binary: an opcode byte plus a body described by a schema
  (`shared/src/binary/schema.ts`, a port of an older BinaryBuilder/BinaryParser).
  Positions are UInt16 in 1/20 px steps, so a snapshot costs 7 bytes per player.
- Client moves locally (instant response) and sends its position at 20 Hz.
- Server validates speed and collision, sends a `correction` if a move is invalid,
  and broadcasts a binary snapshot at 20 Hz when anything changed.
- Other players are rendered 100 ms in the past and interpolated between snapshots.
- Rooms live in memory and disappear when the last socket closes; each keeps the
  last 100 chat messages.

## Load testing

```bash
npm run loadtest -- --steps 500,1000,2000 --room-size 20
```

Spawns a server, ramps up bot players that walk non-stop and chat, and prints per
step: server players, CPU, event loop utilization and delay (read from the server's
`/api/health`), snapshot arrival gaps, chat round-trip and bandwidth. `--room-size 0` puts everyone in one
room. `npm run loadtest -- --help` lists all options; note the `--` after the script
name, without it npm swallows the flags (the tool detects this and stops).

To test a deployed server from this machine, point it at the public URL. Server
columns come from its `/api/health`; if the server sets `HEALTH_TOKEN`, pass it:

```bash
npm run loadtest -- --target https://meet.example.com --health-token $TOKEN --steps 200,500,1000 --room-size 20
npm run loadtest -- --last               # same options again
npm run loadtest -- --last --hold 60     # same, with one option changed
```

`--runtime bun|deno` runs the spawned local server on another runtime to compare them.

`--last` reads `.loadtest-last.json` (git-ignored; it stores the token in plain text).

Bots use rooms named `<room-prefix>-all` / `<room-prefix>-0..n` (default `load`).

By default every bot walks non-stop (worst case). `--moving 0.2` makes each bot walk
20% of the time and stand still (sending nothing) otherwise, closer to a real meeting.
`move p50/p99` is the time from a bot sending a position to seeing it echoed back in
a snapshot, which is the lag other players see; it stays meaningful with idle bots,
unlike snapshot gaps (a room where nobody moves gets no snapshots at all).

## Deploy (Coolify)

Build from the `Dockerfile` (or `Dockerfile.bun` / `Dockerfile.deno` for the other runtimes). The container listens on `PORT` (default 3000) and
exposes `GET /healthz` (plain liveness) and `GET /api/health` (JSON load stats: rooms,
players, CPU, event loop, memory, last 5 minutes of 1 s samples). Set `HEALTH_TOKEN`
to require `Authorization: Bearer <token>` on `/api/health` in production. WebSockets go through the normal HTTP proxy on `/ws`.
