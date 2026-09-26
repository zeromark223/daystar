// Deno entry point: Deno.serve with Deno.upgradeWebSocket.
import { WS_PATH } from "../../shared/src/constants.ts";
import { connect, handleHttp, HOST, IDLE_TIMEOUT_SEC, MAX_FRAME_BYTES, PORT, roomIdFor, startupMessage } from "./app.ts";
import type { PeerEvents } from "./room.ts";

Deno.serve({ port: PORT, hostname: HOST, onListen: () => console.log(startupMessage()) }, (req) => {
  const url = new URL(req.url);
  if (url.pathname !== WS_PATH) return handleHttp(req);
  const roomId = roomIdFor(url);
  if (!roomId || req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Bad request", { status: 400 });
  }

  // idleTimeout makes Deno ping the client and close the socket if pongs stop.
  const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: IDLE_TIMEOUT_SEC });
  socket.binaryType = "arraybuffer";
  let events: PeerEvents | null = null;
  socket.onopen = () => {
    events = connect(roomId, {
      send: (data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(data);
      },
      close: () => socket.close(),
    });
  };
  socket.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    if (e.data.byteLength > MAX_FRAME_BYTES) {
      socket.close(1009, "Message too big");
      return;
    }
    events?.message(new Uint8Array(e.data));
  };
  socket.onclose = () => events?.close();
  return response;
});
