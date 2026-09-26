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

  /**
   * Ask where to connect (the agent in a cluster, the server itself when
   * standalone), then resolve once the socket is open; handlers only start
   * firing after that.
   */
  static async open(roomId: string, onMessage: (msg: ServerMessage) => void, onClose: () => void): Promise<Connection> {
    const res = await fetch("/api/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: roomId }),
    }).catch(() => null);
    if (!res?.ok) throw new Error(res?.status === 503 ? "No game server is available right now." : "Could not reach the server.");
    const { wsUrl } = (await res.json()) as { wsUrl: string };
    // Standalone servers answer with a path on this host; the agent with a full URL.
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(wsUrl.startsWith("/") ? `${protocol}//${location.host}${wsUrl}` : wsUrl);
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
