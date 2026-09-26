import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { CollisionMap } from "../../shared/src/collision.ts";
import { ROOM_ID_PATTERN, WS_PATH } from "../../shared/src/constants.ts";
import type { PlayerInfo } from "../../shared/src/protocol.ts";
import { readServerClusterConfig } from "./cluster/config.ts";
import { readJoinRequest, readLimited, rejectWithoutHealthToken } from "./http.ts";
import { CLIENT_DIR, COLLISION_FILE } from "./paths.ts";
import { Room, type Peer, type PeerEvents, type Publish, type RoomSync } from "./room.ts";
import { StatsSampler } from "./stats.ts";
import { createStaticHandler } from "./static.ts";

/**
 * Game server core: rooms, collision map and HTTP routes as a fetch-style
 * handler; main.ts wires it to Bun.serve and Bun's WebSockets. Runs standalone,
 * or as one server of a cluster when CLUSTER_SECRET is set (docs/cluster.md).
 */

export const PORT = Number(process.env.PORT ?? 3000);
export const HOST = process.env.HOST ?? "0.0.0.0";
/** Largest client frame accepted; real ones are tens of bytes. */
export const MAX_FRAME_BYTES = 4 * 1024;
/** Close sockets that stop answering pings for this long (e.g. a laptop lid closed). */
export const IDLE_TIMEOUT_SEC = 60;

export const cluster = readServerClusterConfig();

const MAX_COLLISION_BYTES = 256 * 1024;
// Saving collision edits (?edit in the client) rewrites a source file, so it is dev-only
// by default, and never in cluster mode (other servers would keep the old map).
const MAP_EDITOR =
  !cluster && (process.env.MAP_EDITOR ? process.env.MAP_EDITOR === "1" : process.env.NODE_ENV !== "production");

const collision = CollisionMap.parse(readFileSync(COLLISION_FILE, "utf8"));
const rooms = new Map<string, Room>();
const serveStatic = createStaticHandler(CLIENT_DIR);
let sockets = 0;

export const stats = new StatsSampler(
  () => {
    let players = 0;
    for (const room of rooms.values()) players += room.playerCount;
    return { rooms: rooms.size, players, sockets };
  },
  // LOG_STATS=1 also prints every sample as a JSON line.
  process.env.LOG_STATS === "1" ? (s) => console.log(JSON.stringify(s)) : undefined,
);

export const startupMessage = () =>
  cluster
    ? `cute-meeting server ${cluster.server} on http://${HOST}:${PORT} (${stats.report().runtime}, cluster, public ${cluster.publicUrl})`
    : `cute-meeting on http://${HOST}:${PORT} (${stats.report().runtime}, standalone, map editor ${MAP_EDITOR ? "on" : "off"})`;

/**
 * Runtimes with native pub/sub (Bun) register how to publish to a room's
 * channel; their peers must then implement Peer.subscribe for the same channel.
 */
let publisherFor: ((roomId: string) => Publish) | null = null;
export function usePublisher(factory: (roomId: string) => Publish): void {
  publisherFor = factory;
}

/** Cluster mode: told about every local join and leave (forwarded to the agent). */
export interface PlayerHooks {
  joined(room: string, player: number): void;
  left(room: string, player: number): void;
}
let hooks: PlayerHooks | null = null;
export function usePlayerHooks(h: PlayerHooks): void {
  hooks = h;
}

/** Cluster mode: rooms are mirrored to other servers hosting them (mesh). */
export interface ClusterRooms {
  syncFor(room: string): RoomSync;
  roomOpened(room: string): void;
  roomClosed(room: string): void;
}
let clusterRooms: ClusterRooms | null = null;
export function useClusterRooms(c: ClusterRooms): void {
  clusterRooms = c;
}

/** Rooms hosted here, for the mesh. */
export const hostedRooms = {
  get: (room: string) => rooms.get(room),
  names: () => rooms.keys(),
};

/** Room id for a WebSocket upgrade URL (/ws?room=<id>), or null if invalid. */
export function roomIdFor(url: URL): string | null {
  const roomId = url.searchParams.get("room") ?? "";
  return ROOM_ID_PATTERN.test(roomId) ? roomId : null;
}

/**
 * Attach an upgraded connection to its room; `playerId` comes from a cluster
 * ticket, `resume` from the previous server when the player is migrating.
 */
export function connect(roomId: string, peer: Peer, playerId?: number, resume?: Promise<PlayerInfo | null>): PeerEvents {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room(roomId, {
      map: collision,
      onEmpty: () => {
        rooms.delete(roomId);
        clusterRooms?.roomClosed(roomId);
      },
      sync: clusterRooms?.syncFor(roomId),
      publish: publisherFor?.(roomId) ?? null,
      onJoined: (player) => hooks?.joined(roomId, player),
      onLeft: (player) => hooks?.left(roomId, player),
      chatIdBase: cluster ? cluster.server * 0x1000000 : 0,
      keepChatHistory: !cluster,
    });
    rooms.set(roomId, room);
    clusterRooms?.roomOpened(roomId);
  }
  sockets++;
  const events = room.accept(peer, playerId, resume);
  return {
    message: events.message,
    close: () => {
      sockets--;
      events.close();
    },
  };
}

/** Every local player, for the agent's register message. */
export function localPlayers(): { room: string; player: number }[] {
  const out: { room: string; player: number }[] = [];
  for (const [room, r] of rooms) for (const player of r.playerIds()) out.push({ room, player });
  return out;
}

/** Every non-WebSocket request. */
export async function handleHttp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    switch (url.pathname) {
      case "/healthz":
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      case "/api/health": {
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        return (
          rejectWithoutHealthToken(req, url) ??
          Response.json(stats.report(since), { headers: { "cache-control": "no-store" } })
        );
      }
      case "/api/join":
        return await handleJoin(req);
      case "/api/collision":
        return await handleCollision(req);
      case WS_PATH:
        return new Response("WebSocket upgrade required", { status: 426 });
      default:
        return await serveStatic(req);
    }
  } catch (err) {
    console.error(err);
    return new Response(null, { status: 500 });
  }
}

/**
 * Standalone only: clients always ask /api/join first; alone, the answer is
 * "this server". In a cluster the agent answers it instead.
 */
async function handleJoin(req: Request): Promise<Response> {
  if (cluster) return new Response("Ask the agent", { status: 404 });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const room = await readJoinRequest(req, ROOM_ID_PATTERN);
  if (!room) return new Response("Invalid room", { status: 400 });
  return Response.json({ serverId: 0, wsUrl: `${WS_PATH}?room=${room}` });
}

async function handleCollision(req: Request): Promise<Response> {
  if (req.method === "GET") {
    return new Response(collision.serialize(), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" },
    });
  }
  if (req.method !== "PUT") return new Response(null, { status: 405, headers: { allow: "GET, PUT" } });
  if (!MAP_EDITOR) return new Response("Map editing is disabled on this server.", { status: 403 });

  const body = await readLimited(req, MAX_COLLISION_BYTES);
  if (body === null) return new Response(null, { status: 413 });
  let edited: CollisionMap;
  try {
    edited = CollisionMap.parse(body);
    collision.copyFrom(edited);
  } catch (err) {
    return new Response((err as Error).message, { status: 400 });
  }
  const tmp = `${COLLISION_FILE}.tmp`;
  await writeFile(tmp, edited.serialize());
  await rename(tmp, COLLISION_FILE);
  console.log(`collision map saved to ${COLLISION_FILE}`);
  return new Response(null, { status: 204 });
}
