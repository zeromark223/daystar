import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { WebSocketServer, type WebSocket } from "ws";
import { CollisionMap } from "../../shared/src/collision.ts";
import { ROOM_ID_PATTERN, WS_PATH } from "../../shared/src/constants.ts";
import { Room } from "./room.ts";
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

const collision = CollisionMap.parse(readFileSync(COLLISION_FILE, "utf8"));
const rooms = new Map<string, Room>();
const serveStatic = createStaticHandler(CLIENT_DIR);

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

// LOG_STATS=<seconds> prints load figures as JSON lines (used by tools/loadtest.ts).
const STATS_SECONDS = Number(process.env.LOG_STATS ?? 0);
if (STATS_SECONDS > 0) {
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  let lastElu = performance.eventLoopUtilization();
  setInterval(() => {
    const elu = performance.eventLoopUtilization(lastElu);
    lastElu = performance.eventLoopUtilization();
    let players = 0;
    for (const room of rooms.values()) players += room.playerCount;
    console.log(
      JSON.stringify({
        stats: true,
        rooms: rooms.size,
        players,
        sockets: wss.clients.size,
        elu: Number(elu.utilization.toFixed(3)),
        loopP99Ms: Number((loopDelay.percentile(99) / 1e6).toFixed(1)),
        loopMaxMs: Number((loopDelay.max / 1e6).toFixed(1)),
        rssMb: Math.round(process.memoryUsage().rss / 1e6),
      }),
    );
    loopDelay.reset();
  }, STATS_SECONDS * 1000);
}

server.listen(PORT, HOST, () => {
  console.log(`cute-meeting listening on http://${HOST}:${PORT} (map editor ${MAP_EDITOR ? "on" : "off"})`);
});
