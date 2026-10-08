# Cluster design

Status: implemented on branch `scale-out` (fallback: `master`).

## Goal

Hold as many concurrent users as possible by running several game servers behind
one agent, before optimizing what each server sends (area of interest etc. comes later).

- A room normally lives on one server (**room affinity**).
- A room may also **span several servers**; players on different servers still see
  each other because servers sync room state directly.
- An **agent** decides which server a client connects to, watches load, and asks
  overloaded servers to move players.
- Start with **4 server processes on one machine**; the design must not assume that
  (URLs come from the agent, servers find each other through the agent).

## Runtime: Bun only

From the cluster version on, the project targets **Bun only**. Node (`server/src/index.ts`,
`ws`) and Deno (`server/src/deno.ts`, `Dockerfile.deno`) entry points are removed
permanently; `Dockerfile` becomes the Bun image. Reasons: Bun's native WebSocket
client/server and topic pub/sub are what the cluster relies on, and Bun measured best
by a wide margin (see load test history in git).

Standalone mode stays: without cluster configuration a single Bun server serves
everything exactly like today. This is the in-code fallback besides the `master` branch.

## Components

```
                     ┌──────────────────────────┐
  browser ──HTTP──▶  │ agent  (talk.ptnn.dev)   │  static client, /api/join, /api/migrate,
                     │ port 3000                │  /api/health (cluster), placement, tickets
                     └───▲──────────▲───────────┘
          register, stats│          │ orders (move players), peer list
                         │          │
   ┌──────────────┐  ┌───┴──────────┴┐  ┌──────────────┐  ┌──────────────┐
   │ server s1    │◀▶│ server s2     │◀▶│ server s3    │◀▶│ server s4    │  mesh: every pair
   │ :3001        │  │ :3002         │  │ :3003        │  │ :3004        │  connected directly
   └──────▲───────┘  └──────▲────────┘  └──────▲───────┘  └──────▲───────┘
          │ WebSocket (wss://s1.talk.ptnn.dev/ws?ticket=…)       │
       clients                                                clients
```

### Agent (single instance)

> **Single point of failure, on purpose for now.** If the agent is down, nobody can
> join or move and the system is considered down. Multiple agents behind a load
> balancer are future work; code comments in the agent must say so.

- Serves the built client and the cluster APIs below.
- Accepts internal WebSocket connections from servers: registration, 1 s stats,
  room membership changes. Pushes the peer list and migration orders back.
- Keeps, per room, which servers host it and how many players each has.
- Allocates player ids and signs tickets (see [Ids and tickets](#ids-and-tickets)).
- Marks a server dead after 3 s without stats; stops placing players there.

### Game server

- Same room logic as today (move validation, 20 Hz delta snapshots, Bun topic
  pub/sub for local fan-out), plus:
- Registers with the agent on start: `{ serverId, publicUrl, meshUrl, capacity }`.
- Verifies the ticket on every client connection.
- Joins the mesh with every peer the agent lists, and syncs rooms that span servers.
- Obeys migration orders from the agent.

### Supervisor

`server/src/supervisor.ts` is the container entry point. With `CLUSTER_SERVERS=0`
(the image default) it runs one standalone server; with N > 0 it starts the agent and
N game servers as child processes, prefixes their logs (`[agent]`, `[s1]`, …) and
restarts any that exit (backoff up to 10 s). `bun run cluster` runs it locally with 4.

## Placement

Load is measured primarily in **players** against a configured capacity per server
(`SERVER_CAPACITY`, because capacity differs per machine; the laptop and the Xeon
host measured very differently). Loop p99 is only an overload signal.

- Soft limit = 70% of capacity, hard limit = 90%.
- **New room** → least-loaded live server; that server becomes the room's home.
- **Joining an existing room**, first match wins:
  1. the room's home server, if under the soft limit;
  2. another server already hosting the room, under the soft limit;
  3. the least-loaded live server (the room now spans one more server).
- **Overload**: a server above the hard limit, or with loop p99 > 40 ms for 5
  consecutive samples, gets an order "move k players of room R". The agent prefers
  moving players to servers that already host R (the move is then seamless, see below).
  At most 10% of a server's players per order; 30 s cooldown per server (hysteresis).
- Placement is a pure function of the agent's view, unit-tested on its own.

## Client flow

The room URL does not change: `/r/<room-id>`. The room id stays the logical id; the
agent knows where it lives (server ids are never part of room ids).

1. **Join**: `POST /api/join { room }` to the agent → `{ serverId, wsUrl, ticket }`.
   Connect to `wsUrl?ticket=…`, then send the usual `join { name, character }`.
2. **Migrate on request**: the server sends `migrate {}`. The client calls
   `POST /api/migrate { ticket }` → new `{ serverId, wsUrl, ticket }` (same player id),
   opens the new socket, sends `join` again, and closes the old socket only after
   `welcome`. No lobby, no "left/joined" lines for other players; a short hitch at most.
3. **Server lost unexpectedly**: the client asks the agent again (`/api/join`) and
   rejoins the same room automatically. Only an agent failure shows "Connection lost".

In standalone mode the server itself answers `/api/join` with its own URL, so the
client has a single code path.

## Ids and tickets

- **Player ids are allocated by the agent, unique within a room**, still `u16`, so
  snapshot entries stay small (8 bytes per player). Freed ids are reused only after a delay.
  > Future: a global id scheme (e.g. `u32`, +2 bytes per snapshot entry, ~28% more
  > snapshot bandwidth) or ids minted by servers under a shared rule, so the agent
  > is not on the id path. Kept simple for now.
- **Ticket** = `base64url(payload) + "." + base64url(HMAC-SHA256(payload, CLUSTER_SECRET))`,
  payload `{ v: 1, room, server, player, exp, from? }`:
  - `exp`: 30 s after issue.
  - `from`: set on migration tickets, the server the player is leaving.
  > Future: tickets are not single-use; replay is only limited by `exp`. Add a nonce
  > cache on servers if that ever matters.

## Mesh sync (rooms spanning servers)

- Every pair of servers keeps one WebSocket, authenticated with `CLUSTER_SECRET`
  (HMAC of a server-chosen nonce). Frames use the same schema encoder as the client
  protocol, with their own opcodes.
- Only rooms present on several servers cost anything: a server announces
  `interest { room, on/off }` when it gains its first / loses its last local player
  in a room. Peers that are interested get that room's events:
  - `room_state` (all locally owned players) when interest starts,
  - `player_joined` / `player_left` (between servers; clients get them inside the
    next snapshot),
  - `moves`: the locally owned players that changed, **one frame per room per peer per
    tick**, merged into the receiver's next tick. Cross-server visibility therefore
    costs up to one extra tick (≤ 50 ms), accepted to keep message counts flat,
  - `chat` (live messages only),
  - `role` (a local player's role changed) and `voice` (frames from local speakers,
    one frame per room per peer per tick, like `moves`).
- `set_role` goes to one server only: the owner of the player whose role the host
  changes (see [voice.md](voice.md)).
- **Authority**: the server holding a player's socket owns that player (move
  validation, chat rate limit, role, voice rate limit). Other servers keep a read-only replica and never
  forward replicas (no echo).
- `welcome` lists local and replicated players.
- **Peer lost**: players owned by that server are removed from every room, with the
  usual `player_left` to local clients.
- **Chat history is not synced.** In cluster mode `welcome` carries no history.
  > Future: chat history moves to a database behind a separate, independent service.
- **Chat ids** are `serverId << 24 | counter` so they stay unique across servers.

> Future: replace the direct mesh with Redis Streams or Kafka once there are more
> servers or machines; the mesh keeps the message shapes so the swap stays local.

## Migration handshake

1. Agent → s1: `move k players of room R` (optionally "to s2").
2. s1 picks k random local players of R and sends each `migrate {}`.
3. Client → agent `/api/migrate`; agent picks the target with the placement rules
   (excluding s1 and overloaded servers) and issues a ticket with `from: s1`.
4. Client connects to s2. s2 asks s1 over the mesh for player P (`takeover`); s1 replies
   with P's state and marks P as moved, so closing P's old socket later sends no
   `player_left`. If s2 already replicates R it uses its replica immediately.
5. s2 announces P as locally owned to interested peers; clients just see P keep moving.
6. If s1 is unreachable (or does not answer within 1.5 s), s2 spawns P at the room spawn
   point. If the client never moves, s1 simply keeps P (no kick) and may ask it again
   after 30 s.

## Configuration

Set on the container (the supervisor derives the per-process ones):

| Variable | Default | Meaning |
|---|---|---|
| `CLUSTER_SERVERS` | `0` | number of game servers; `0` = standalone |
| `CLUSTER_SECRET` | random per container | HMAC key for tickets, mesh auth and host keys (set it, or hosts lose their rooms on restart) |
| `SERVER_CAPACITY` | `2000` | players per server at 100% load (tune per machine with the load test) |
| `SERVER_PUBLIC_URL_TEMPLATE` | `ws://localhost:{port}/ws` | client-facing server URL; `{id}` and `{port}` are replaced |
| `SERVER_BASE_PORT` | `PORT + 1` | first game server port |
| `PORT` | `3000` | agent (or standalone server) port |
| `HEALTH_TOKEN` | unset | protects `/api/health` |

Derived per process by the supervisor: `SERVER_ID`, `SERVER_PUBLIC_URL`,
`SERVER_MESH_URL` (`ws://127.0.0.1:<port>/mesh`), `AGENT_URL`
(`ws://127.0.0.1:<PORT>/internal`), and `PORT` for each game server.

## Deployment (Coolify)

One container, same image as standalone:

1. Environment: `CLUSTER_SERVERS=4`, `CLUSTER_SECRET=<random>`, `SERVER_CAPACITY=<n>`,
   `SERVER_PUBLIC_URL_TEMPLATE=wss://talk-s{id}.ptnn.dev/ws`, `HEALTH_TOKEN=<token>`.
2. Domains on the Coolify service, one per container port:
   `https://talk.ptnn.dev:3000,https://talk-s1.ptnn.dev:3001,…,https://talk-s4.ptnn.dev:3004`.
3. Cloudflare DNS: `talk-s1` … `talk-s4` records, proxied.

Server hostnames must be **first-level** subdomains (`talk-s1.ptnn.dev`, not
`s1.talk.ptnn.dev`): Cloudflare's free Universal SSL certificate only covers the apex
and first-level subdomains, so a proxied second-level name fails TLS.

## Load test

- Bots join through the agent (`/api/join`), follow `migrate`, and rejoin on server loss
  (`migr` and `rejoin` columns).
- Server columns come from the agent's aggregated `/api/health`; a second line per step
  shows each server's players, CPU and loop p99.
- `--cluster N [--capacity C]` spawns a local cluster; `--target` tests a deployed one.

## Milestones

1. **Bun only**: remove Node and Deno entry points, `ws`, `Dockerfile.deno`; Bun `Dockerfile`.
2. **Agent + tickets + join flow**, rooms on a single server (affinity only). Client uses
   `/api/join`; standalone mode answers it too.
3. **Mesh sync**: rooms spanning servers; two bots on different servers see each other.
4. **Migration and overload handling**, including client auto-rejoin on server loss.
5. **Supervisor, Docker, Coolify domains**, load test through the agent.

Each milestone ends with unit tests, a local cluster run, and a load test.

## Out of scope (future)

- Several agents behind a load balancer (agent is a single point of failure today).
- Redis Streams / Kafka instead of the direct mesh.
- Chat history in a separate database service.
- Global player id scheme; single-use tickets.
- Area of interest and other per-server bandwidth optimizations.
