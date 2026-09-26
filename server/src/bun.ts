// Bun entry point: Bun.serve with its native (uWebSockets-based) WebSocket server.
import { WS_PATH } from "../../shared/src/constants.ts";
import { connect, handleHttp, HOST, IDLE_TIMEOUT_SEC, MAX_FRAME_BYTES, PORT, roomIdFor, startupMessage } from "./app.ts";
import type { PeerEvents } from "./room.ts";

interface SocketData {
  roomId: string;
  events?: PeerEvents;
}

Bun.serve<SocketData>({
  port: PORT,
  hostname: HOST,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname !== WS_PATH) return handleHttp(req);
    const roomId = roomIdFor(url);
    if (!roomId || !server.upgrade(req, { data: { roomId } })) {
      return new Response("Bad request", { status: 400 });
    }
    return undefined;
  },
  websocket: {
    maxPayloadLength: MAX_FRAME_BYTES,
    idleTimeout: IDLE_TIMEOUT_SEC,
    sendPings: true,
    open(ws) {
      ws.data.events = connect(ws.data.roomId, { send: (data) => void ws.send(data), close: () => ws.close() });
    },
    message(ws, message) {
      if (typeof message !== "string") ws.data.events?.message(message);
    },
    close(ws) {
      ws.data.events?.close();
    },
  },
});

console.log(startupMessage());
