import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CollisionMap } from "../../shared/src/collision.ts";
import { ROOM_ID_PATTERN, WS_PATH } from "../../shared/src/constants.ts";
import { Room, type Peer, type PeerEvents } from "./room.ts";
import { StatsSampler } from "./stats.ts";
import { createStaticHandler } from "./static.ts";

/**
 * Runtime-independent server core: rooms, collision map and HTTP routes as a
 * fetch-style handler. index.ts (Node), bun.ts and deno.ts only adapt their
 * HTTP server and WebSocket implementation to it.
 */

export const PORT = Number(process.env.PORT ?? 3000);
export const HOST = process.env.HOST ?? "0.0.0.0";
/** Largest client frame accepted; real ones are tens of bytes. */
export const MAX_FRAME_BYTES = 4 * 1024;
/** Close sockets that stop answering pings for this long (e.g. a laptop lid closed). */
export const IDLE_TIMEOUT_SEC = 60;

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const CLIENT_DIR = fromHere("../../client/dist");
const MAX_COLLISION_BYTES = 256 * 1024;

// The editable source lives in client/public; production images only ship client/dist.
const COLLISION_SOURCE = fromHere("../../client/public/assets/collision.txt");
const COLLISION_FILE = existsSync(COLLISION_SOURCE) ? COLLISION_SOURCE : fromHere("../../client/dist/assets/collision.txt");
// Saving collision edits (?edit in the client) rewrites a source file, so it is dev-only by default.
const MAP_EDITOR = process.env.MAP_EDITOR ? process.env.MAP_EDITOR === "1" : process.env.NODE_ENV !== "production";
// GET /api/health requires "Authorization: Bearer <HEALTH_TOKEN>" (or ?token=) when set.
const HEALTH_TOKEN = process.env.HEALTH_TOKEN ?? "";

const collision = CollisionMap.parse(readFileSync(COLLISION_FILE, "utf8"));
const rooms = new Map<string, Room>();
const serveStatic = createStaticHandler(CLIENT_DIR);
let sockets = 0;

const stats = new StatsSampler(
  () => {
    let players = 0;
    for (const room of rooms.values()) players += room.playerCount;
    return { rooms: rooms.size, players, sockets };
  },
  // LOG_STATS=1 also prints every sample as a JSON line.
  process.env.LOG_STATS === "1" ? (s) => console.log(JSON.stringify(s)) : undefined,
);

export const startupMessage = () =>
  `cute-meeting on http://${HOST}:${PORT} (${stats.report().runtime}, map editor ${MAP_EDITOR ? "on" : "off"})`;

/** Room id for a WebSocket upgrade URL (/ws?room=<id>), or null if invalid. */
export function roomIdFor(url: URL): string | null {
  const roomId = url.searchParams.get("room") ?? "";
  return ROOM_ID_PATTERN.test(roomId) ? roomId : null;
}

/** Attach an upgraded connection to its room. */
export function connect(roomId: string, peer: Peer): PeerEvents {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room(roomId, collision, () => rooms.delete(roomId));
    rooms.set(roomId, room);
  }
  sockets++;
  const events = room.accept(peer);
  return {
    message: events.message,
    close: () => {
      sockets--;
      events.close();
    },
  };
}

/** Every non-WebSocket request. */
export async function handleHttp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    switch (url.pathname) {
      case "/healthz":
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      case "/api/health":
        return handleHealth(req, url);
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

function handleHealth(req: Request, url: URL): Response {
  if (HEALTH_TOKEN) {
    const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
    if (!constantTimeEqual(given, HEALTH_TOKEN)) {
      return new Response("Unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
    }
  }
  const since = Number(url.searchParams.get("since") ?? 0) || 0;
  return Response.json(stats.report(since), { headers: { "cache-control": "no-store" } });
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

/** Request body as text, or null once it exceeds `limit` bytes. */
async function readLimited(req: Request, limit: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
