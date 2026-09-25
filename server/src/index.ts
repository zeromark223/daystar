import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { CollisionMap } from "../../shared/src/collision.ts";
import { ROOM_ID_PATTERN, WS_PATH } from "../../shared/src/constants.ts";
import { Room } from "./room.ts";
import { StatsSampler } from "./stats.ts";
import { createStaticHandler } from "./static.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const CLIENT_DIR = resolve(import.meta.dirname, "../../client/dist");
const HEARTBEAT_MS = 30_000;
const MAX_COLLISION_BYTES = 256 * 1024;

// The editable source lives in client/public; production images only ship client/dist.
const COLLISION_SOURCE = resolve(import.meta.dirname, "../../client/public/assets/collision.txt");
const COLLISION_FILE = existsSync(COLLISION_SOURCE) ? COLLISION_SOURCE : resolve(CLIENT_DIR, "assets/collision.txt");
// Saving collision edits (?edit in the client) rewrites a source file, so it is dev-only by default.
const MAP_EDITOR = process.env.MAP_EDITOR ? process.env.MAP_EDITOR === "1" : process.env.NODE_ENV !== "production";

// GET /api/health requires "Authorization: Bearer <HEALTH_TOKEN>" (or ?token=) when set.
const HEALTH_TOKEN = process.env.HEALTH_TOKEN ?? "";

const collision = CollisionMap.parse(readFileSync(COLLISION_FILE, "utf8"));
const rooms = new Map<string, Room>();
const serveStatic = createStaticHandler(CLIENT_DIR);

const stats = new StatsSampler(
  () => {
    let players = 0;
    for (const room of rooms.values()) players += room.playerCount;
    return { rooms: rooms.size, players, sockets: wss.clients.size };
  },
  // LOG_STATS=1 also prints every sample as a JSON line.
  process.env.LOG_STATS === "1" ? (s) => console.log(JSON.stringify(s)) : undefined,
);

function handleHealth(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (HEALTH_TOKEN) {
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
    const a = Buffer.from(given);
    const b = Buffer.from(HEALTH_TOKEN);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.writeHead(401, { "content-type": "text/plain" }).end("Unauthorized");
      return;
    }
  }
  const since = Number(url.searchParams.get("since") ?? 0) || 0;
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(stats.report(since)));
}

async function handleCollision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
    res.end(collision.serialize());
    return;
  }
  if (req.method !== "PUT") {
    res.writeHead(405, { allow: "GET, PUT" }).end();
    return;
  }
  if (!MAP_EDITOR) {
    res.writeHead(403, { "content-type": "text/plain" }).end("Map editing is disabled on this server.");
    return;
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_COLLISION_BYTES) {
      res.writeHead(413).end();
      return;
    }
  }
  let edited: CollisionMap;
  try {
    edited = CollisionMap.parse(body);
    collision.copyFrom(edited);
  } catch (err) {
    res.writeHead(400, { "content-type": "text/plain" }).end((err as Error).message);
    return;
  }
  const tmp = `${COLLISION_FILE}.tmp`;
  await writeFile(tmp, edited.serialize());
  await rename(tmp, COLLISION_FILE);
  console.log(`collision map saved to ${COLLISION_FILE}`);
  res.writeHead(204).end();
}

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (req.url?.split("?")[0] === "/api/health") {
    handleHealth(req, res);
    return;
  }
  if (req.url === "/api/collision") {
    handleCollision(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    return;
  }
  serveStatic(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
const alive = new WeakSet<WebSocket>();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const roomId = url.searchParams.get("room") ?? "";
  if (url.pathname !== WS_PATH || !ROOM_ID_PATTERN.test(roomId)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    let room = rooms.get(roomId);
    if (!room) {
      room = new Room(roomId, collision, () => rooms.delete(roomId));
      rooms.set(roomId, room);
    }
    room.accept(ws);
  });
});

// Drop connections that stopped answering pings (e.g. a laptop lid closed).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, HEARTBEAT_MS);

server.listen(PORT, HOST, () => {
  console.log(`cute-meeting listening on http://${HOST}:${PORT} (map editor ${MAP_EDITOR ? "on" : "off"})`);
});
