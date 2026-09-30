import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../shared/src/protocol.ts";

export interface ConnectionHandlers {
  onMessage(msg: ServerMessage, from: Connection): void;
  /** The socket closed without us asking (server or network gone). */
  onLost(conn: Connection): void;
}

interface Placement {
  wsUrl: string;
  /** Cluster ticket (null standalone), kept for /api/migrate. */
  ticket: string | null;
}

async function post(path: string, body: object): Promise<Placement> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res?.ok) throw new Error(res?.status === 503 ? "No game server is available right now." : "Could not reach the server.");
  const { wsUrl, ticket } = (await res.json()) as { wsUrl: string; ticket?: string };
  return { wsUrl, ticket: ticket ?? null };
}

/** Ask for a new room; its creator gets the host key (the agent answers in a cluster). */
export async function createRoom(): Promise<{ room: string; hostKey: string }> {
  const res = await fetch("/api/rooms", { method: "POST" }).catch(() => null);
  if (!res?.ok) throw new Error("Could not create a room right now.");
  return (await res.json()) as { room: string; hostKey: string };
}

export class Connection {
  private readonly ws: WebSocket;
  readonly ticket: string | null;
  private closing = false;

  private constructor(ws: WebSocket, ticket: string | null, handlers: ConnectionHandlers) {
    this.ws = ws;
    this.ticket = ticket;
    ws.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const msg = decodeServerMessage(new Uint8Array(event.data));
      if (msg) handlers.onMessage(msg, this);
    });
    ws.addEventListener("close", () => {
      if (!this.closing) handlers.onLost(this);
    });
    // Leave promptly on navigation instead of waiting for the server heartbeat.
    window.addEventListener("pagehide", () => this.close());
  }

  /**
   * Ask where to connect (the agent in a cluster, the server itself when
   * standalone), then resolve once the socket is open.
   */
  static async open(roomId: string, handlers: ConnectionHandlers): Promise<Connection> {
    return Connection.connect(await post("/api/join", { room: roomId }), handlers);
  }

  /** Cluster: our server asked us to move; get a ticket for another server. */
  static async migrate(ticket: string, handlers: ConnectionHandlers): Promise<Connection> {
    return Connection.connect(await post("/api/migrate", { ticket }), handlers);
  }

  private static connect({ wsUrl, ticket }: Placement, handlers: ConnectionHandlers): Promise<Connection> {
    // Standalone servers answer with a path on this host; the agent with a full URL.
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(wsUrl.startsWith("/") ? `${protocol}//${location.host}${wsUrl}` : wsUrl);
    ws.binaryType = "arraybuffer";
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(new Connection(ws, ticket, handlers)), { once: true });
      ws.addEventListener("error", () => reject(new Error("Could not reach the server.")), { once: true });
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeClientMessage(msg));
  }

  /** Close on purpose (migration, leaving); not reported as lost. */
  close(): void {
    this.closing = true;
    this.ws.close();
  }
}
