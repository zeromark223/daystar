import { WS_PATH } from "../../shared/src/constants.ts";
import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../shared/src/protocol.ts";

export class Connection {
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket, onMessage: (msg: ServerMessage) => void, onClose: () => void) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const msg = decodeServerMessage(new Uint8Array(event.data));
      if (msg) onMessage(msg);
    });
    ws.addEventListener("close", onClose);
    // Leave promptly on navigation instead of waiting for the server heartbeat.
    window.addEventListener("pagehide", () => ws.close());
  }

  /** Resolve once the socket is open; handlers only start firing after that. */
  static open(roomId: string, onMessage: (msg: ServerMessage) => void, onClose: () => void): Promise<Connection> {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}${WS_PATH}?room=${encodeURIComponent(roomId)}`);
    ws.binaryType = "arraybuffer";
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(new Connection(ws, onMessage, onClose)), { once: true });
      ws.addEventListener("error", () => reject(new Error("Could not reach the server.")), { once: true });
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeClientMessage(msg));
  }
}
