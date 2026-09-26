// Node entry point: node:http + the `ws` library.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { WS_PATH } from "../../shared/src/constants.ts";
import { connect, handleHttp, HOST, IDLE_TIMEOUT_SEC, MAX_FRAME_BYTES, PORT, roomIdFor, startupMessage } from "./app.ts";

async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  let body: Buffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body });
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

const server = createServer((req, res) => {
  toRequest(req)
    .then(handleHttp)
    .then((response) => sendResponse(res, response))
    .catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
const alive = new WeakSet<WebSocket>();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const roomId = url.pathname === WS_PATH ? roomIdFor(url) : null;
  if (!roomId) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    const events = connect(roomId, { send: (data) => ws.send(data), close: () => ws.close() });
    ws.on("message", (data: Buffer, isBinary) => {
      if (isBinary) events.message(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    });
    ws.on("close", events.close);
  });
});

// Ping every half idle timeout; drop sockets that missed a whole round.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, (IDLE_TIMEOUT_SEC * 1000) / 2);

server.listen(PORT, HOST, () => console.log(startupMessage()));
