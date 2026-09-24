import { WS_PATH } from "../../shared/src/constants.ts";
import {
  decodeSnapshot,
  encodeMove,
  type ClientMessage,
  type PlayerState,
  type ServerMessage,
} from "../../shared/src/protocol.ts";
import type { Direction } from "../../shared/src/characters.ts";

export interface ConnectionHandlers {
  onMessage(msg: ServerMessage): void;
  onSnapshot(players: PlayerState[]): void;
  onClose(): void;
}

export class Connection {
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket, handlers: ConnectionHandlers) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        const players = decodeSnapshot(new DataView(event.data));
        if (players) handlers.onSnapshot(players);
      } else {
        handlers.onMessage(JSON.parse(event.data as string) as ServerMessage);
      }
    });
    ws.addEventListener("close", () => handlers.onClose());
    // Leave promptly on navigation instead of waiting for the server heartbeat.
    window.addEventListener("pagehide", () => ws.close());
  }

  /** Resolve once the socket is open; handlers only start firing after that. */
  static open(roomId: string, handlers: ConnectionHandlers): Promise<Connection> {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}${WS_PATH}?room=${encodeURIComponent(roomId)}`);
    ws.binaryType = "arraybuffer";
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(new Connection(ws, handlers)), { once: true });
      ws.addEventListener("error", () => reject(new Error("Could not reach the server.")), { once: true });
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendMove(x: number, y: number, dir: Direction, moving: boolean): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeMove(x, y, dir, moving));
  }
}
