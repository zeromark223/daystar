import { createServer } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { ROOM_ID_PATTERN, WS_PATH } from "../../shared/src/constants.ts";
import { Room } from "./room.ts";
import { createStaticHandler } from "./static.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const CLIENT_DIR = resolve(import.meta.dirname, "../../client/dist");
const HEARTBEAT_MS = 30_000;

const rooms = new Map<string, Room>();
const serveStatic = createStaticHandler(CLIENT_DIR);

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
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
      room = new Room(roomId, () => rooms.delete(roomId));
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
  console.log(`cute-meeting listening on http://${HOST}:${PORT}`);
});
