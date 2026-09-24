# Cute Meeting

A tiny meeting app that plays like a game: pick an animal, walk around a pixel-art
ruin with everyone else in the room, and chat. Voice chat comes later.

- **Client:** PixiJS v8 + Vite (TypeScript)
- **Server:** Node 24 + `ws`, runs TypeScript directly (native type stripping) and
  serves the built client
- **Transport:** WebSocket only — JSON text frames for events/chat, small binary
  frames for positions

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

Spawns the server with `LOG_STATS=1`, ramps up bot players that walk non-stop and
chat, and prints per step: server CPU, event loop utilization and delay, snapshot
arrival gaps, chat round-trip and bandwidth. `--room-size 0` puts everyone in one
room. See the header of `tools/loadtest.ts` for all options.

## Deploy (Coolify)

Build from the `Dockerfile`. The container listens on `PORT` (default 3000) and
exposes `GET /healthz`. WebSockets go through the normal HTTP proxy on `/ws`.
