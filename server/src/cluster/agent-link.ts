import type { AgentToServer, ServerToAgent } from "./control.ts";
import type { ServerClusterConfig } from "./config.ts";
import { serverToken } from "./ticket.ts";

const RECONNECT_MS = 1000;

/**
 * A game server's connection to the agent. Registers on every (re)connect with
 * the full list of local players, so the agent's view heals after a blip.
 * Messages sent while disconnected are dropped; the next register resyncs.
 */
export class AgentLink {
  private ws: WebSocket | null = null;
  private readonly cfg: ServerClusterConfig;
  private readonly players: () => { room: string; player: number }[];
  private readonly onMessage: (msg: AgentToServer) => void;

  constructor(
    cfg: ServerClusterConfig,
    players: () => { room: string; player: number }[],
    onMessage: (msg: AgentToServer) => void,
  ) {
    this.cfg = cfg;
    this.players = players;
    this.onMessage = onMessage;
  }

  start(): void {
    const url = new URL(this.cfg.agentUrl);
    url.searchParams.set("token", serverToken(this.cfg.server, this.cfg.secret));
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      const { secret: _secret, agentUrl: _agentUrl, ...info } = this.cfg;
      this.send({ t: "register", ...info, players: this.players() });
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.onMessage(JSON.parse(event.data) as AgentToServer);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      console.warn(`agent link closed; reconnecting in ${RECONNECT_MS} ms`);
      setTimeout(() => this.start(), RECONNECT_MS);
    });
    ws.addEventListener("error", () => {
      // "close" follows and schedules the reconnect.
    });
  }

  send(msg: ServerToAgent): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
