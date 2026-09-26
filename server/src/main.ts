// Game server entry point: Bun.serve with its native (uWebSockets-based) WebSocket
// server. Standalone by default; a cluster member when CLUSTER_SECRET is set.
import { WS_PATH } from "../../shared/src/constants.ts";
import {
  cluster,
  connect,
  handleHttp,
  HOST,
  IDLE_TIMEOUT_SEC,
  localPlayers,
  MAX_FRAME_BYTES,
  PORT,
  roomIdFor,
  startupMessage,
  stats,
  usePlayerHooks,
  usePublisher,
} from "./app.ts";
import { AgentLink } from "./cluster/agent-link.ts";
import { verifyPlayer } from "./cluster/ticket.ts";
import type { PeerEvents } from "./room.ts";

interface SocketData {
  roomId: string;
  /** From the ticket in cluster mode; the room allocates one otherwise. */
  playerId?: number;
  events?: PeerEvents;
}

const topic = (roomId: string) => `room:${roomId}`;

/** In cluster mode a client must present a ticket the agent signed for this server and room. */
function admit(url: URL, roomId: string): SocketData | Response {
  if (!cluster) return { roomId };
  const ticket = verifyPlayer(url.searchParams.get("ticket") ?? "", cluster.secret);
  if (!ticket || ticket.server !== cluster.server || ticket.room !== roomId) {
    return new Response("Invalid or expired ticket", { status: 401 });
  }
  return { roomId, playerId: ticket.player };
}

const server = Bun.serve<SocketData>({
  port: PORT,
  hostname: HOST,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname !== WS_PATH) return handleHttp(req);
    const roomId = roomIdFor(url);
    if (!roomId) return new Response("Bad request", { status: 400 });
    const data = admit(url, roomId);
    if (data instanceof Response) return data;
    if (!server.upgrade(req, { data })) return new Response("Bad request", { status: 400 });
    return undefined;
  },
  websocket: {
    maxPayloadLength: MAX_FRAME_BYTES,
    idleTimeout: IDLE_TIMEOUT_SEC,
    sendPings: true,
    open(ws) {
      ws.data.events = connect(
        ws.data.roomId,
        {
          send: (data) => void ws.send(data),
          close: () => ws.close(),
          subscribe: () => ws.subscribe(topic(ws.data.roomId)),
        },
        ws.data.playerId,
      );
    },
    message(ws, message) {
      if (typeof message !== "string") ws.data.events?.message(message);
    },
    close(ws) {
      ws.data.events?.close();
    },
  },
});

// Room broadcasts fan out inside Bun (one call per frame, not one per player).
usePublisher((roomId) => {
  const name = topic(roomId);
  return (data) => void server.publish(name, data);
});

if (cluster) {
  const agent = new AgentLink(cluster, localPlayers, (msg) => {
    // Peer lists (mesh) and move orders (migration) arrive in later milestones.
    void msg;
  });
  usePlayerHooks({
    joined: (room, player) => agent.send({ t: "joined", room, player }),
    left: (room, player) => agent.send({ t: "left", room, player }),
  });
  stats.listeners.add((sample) => agent.send({ t: "stats", sample }));
  agent.start();
}

console.log(startupMessage());
