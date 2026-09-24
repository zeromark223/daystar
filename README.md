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
- `python3 tools/gen_collision.py [overlay.png]` derives the walkability grid in
  `shared/src/map/collision.ts` from the map colors, plus hand-placed polygons for
  stairs and passages (`WALKABLE_OVERRIDES`). Re-running it overwrites manual edits
  to the grid.

## Networking

- Client moves locally (instant response) and sends its position at 20 Hz.
- Server validates speed and collision, sends a `correction` if a move is invalid,
  and broadcasts a binary snapshot at 20 Hz when anything changed.
- Other players are rendered 100 ms in the past and interpolated between snapshots.
- Rooms live in memory and disappear when the last socket closes; each keeps the
  last 100 chat messages.

## Deploy (Coolify)

Build from the `Dockerfile`. The container listens on `PORT` (default 3000) and
exposes `GET /healthz`. WebSockets go through the normal HTTP proxy on `/ws`.
