// Game server entry point: Bun.serve with its native (uWebSockets-based) WebSocket
// server. Standalone by default; a cluster member when CLUSTER_SECRET is set.
import { WS_PATH } from "../../shared/src/constants.ts";
import {
  cluster,
  connect,
  handleHttp,
  hostedRooms,
  HOST,
  IDLE_TIMEOUT_SEC,
  localPlayers,
  MAX_FRAME_BYTES,
  PORT,
  roomIdFor,
  startupMessage,
  stats,
  useClusterRooms,
  usePlayerHooks,
  usePublisher,
} from "./app.ts";
import { AgentLink } from "./cluster/agent-link.ts";
import { Mesh } from "./cluster/mesh.ts";
import { verifyPlayer, verifyServer } from "./cluster/ticket.ts";
import { tlsFromEnv } from "./http.ts";
import { CLIENT_DIR } from "./paths.ts";
import type { PeerEvents } from "./room.ts";
import { warnIfClientMissing } from "./static.ts";

/** A client socket, or (cluster) a mesh link from another game server. */
type SocketData =
  | {
      kind: "client";
      roomId: string;
      /** From the ticket in cluster mode; the room allocates one otherwise. */
      playerId?: number;
      /** Migration ticket: the server the player is leaving. */
      from?: number;
      events?: PeerEvents;
    }
  | { kind: "mesh"; server: number; events?: { message(data: Uint8Array): void; close(): void } };

const MESH_PATH = "/mesh";
const tls = tlsFromEnv();
// Cluster links (agent, mesh) and the agent's URLs are plain ws:// inside the container.
if (tls && cluster) throw new Error("TLS_CERT / TLS_KEY are for standalone testing, not cluster mode");
const mesh = cluster ? new Mesh(cluster.server, cluster.secret, hostedRooms) : null;
if (mesh) useClusterRooms(mesh);

const topic = (roomId: string) => `room:${roomId}`;

/** In cluster mode a client must present a ticket the agent signed for this server and room. */
function admit(url: URL, roomId: string): SocketData | Response {
  if (!cluster) return { kind: "client", roomId };
  const ticket = verifyPlayer(url.searchParams.get("ticket") ?? "", cluster.secret);
  if (!ticket || ticket.server !== cluster.server || ticket.room !== roomId) {
    return new Response("Invalid or expired ticket", { status: 401 });
  }
  return { kind: "client", roomId, playerId: ticket.player, from: ticket.from };
}

const server = Bun.serve<SocketData>({
  port: PORT,
  hostname: HOST,
  tls,
  fetch(req, server) {
    const url = new URL(req.url);
    if (mesh && url.pathname === MESH_PATH) {
      const token = verifyServer(url.searchParams.get("token") ?? "", cluster!.secret);
      if (!token || !server.upgrade(req, { data: { kind: "mesh", server: token.server } })) {
        return new Response("Unauthorized", { status: 401 });
      }
      return undefined;
    }
    if (url.pathname !== WS_PATH) return handleHttp(req);
    const roomId = roomIdFor(url);
    if (!roomId) return new Response("Bad request", { status: 400 });
    const data = admit(url, roomId);
    if (data instanceof Response) return data;
    if (!server.upgrade(req, { data })) return new Response("Bad request", { status: 400 });
    return undefined;
  },
  websocket: {
    // Mesh frames (a whole room's state) can be large; client frames are capped below.
    maxPayloadLength: 16 * 1024 * 1024,
    idleTimeout: IDLE_TIMEOUT_SEC,
    sendPings: true,
    open(ws) {
      const data = ws.data;
      if (data.kind === "mesh") {
        data.events = mesh!.attach(data.server, { send: (d) => void ws.send(d), close: () => ws.close() });
        return;
      }
      // A migrating player: fetch its state from the server it is leaving.
      const resume =
        mesh && data.from !== undefined && data.playerId !== undefined
          ? mesh.takeover(data.from, data.roomId, data.playerId)
          : undefined;
      data.events = connect(
        data.roomId,
        {
          send: (d) => void ws.send(d),
          close: () => ws.close(),
          subscribe: () => ws.subscribe(topic(data.roomId)),
        },
        data.playerId,
        resume,
      );
    },
    message(ws, message) {
      if (typeof message === "string") return;
      if (ws.data.kind === "client" && message.byteLength > MAX_FRAME_BYTES) {
        ws.close(1009, "Message too big");
        return;
      }
      ws.data.events?.message(message);
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
  const agent: AgentLink = new AgentLink(cluster, localPlayers, (msg) => {
    if (msg.t === "peers") {
      mesh!.setPeers(msg.peers);
    } else if (msg.t === "move") {
      // Shed load: ask some players of the room to reconnect through the agent.
      for (const player of hostedRooms.get(msg.room)?.pickMigrants(msg.count) ?? []) {
        agent.send({ t: "migrating", room: msg.room, player });
      }
    }
  });
  usePlayerHooks({
    joined: (room, player) => agent.send({ t: "joined", room, player }),
    left: (room, player) => agent.send({ t: "left", room, player }),
  });
  stats.listeners.add((sample) => agent.send({ t: "stats", sample }));
  agent.start();
}

console.log(startupMessage());
warnIfClientMissing(CLIENT_DIR);
