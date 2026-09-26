import type { Room, RoomSync } from "../room.ts";
import { decodeMesh, encodeMesh, type MeshMessage } from "./mesh-protocol.ts";
import { serverToken } from "./ticket.ts";

const REDIAL_MS = 1000;

/** One direct connection to another game server. */
export interface MeshLink {
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
}

/** What the mesh needs from the local server's rooms. */
export interface MeshRooms {
  get(room: string): Room | undefined;
  names(): Iterable<string>;
}

/**
 * Direct server-to-server room sync (docs/cluster.md "Mesh sync"). Every pair of
 * servers keeps one WebSocket; the lower id dials the higher one. A server
 * announces interest in a room while it hosts it, and only interested peers get
 * that room's events, so rooms living on one server cost nothing.
 *
 * Future: Redis Streams or Kafka instead of direct sockets, same message shapes.
 */
export class Mesh {
  private readonly self: number;
  private readonly secret: string;
  private readonly rooms: MeshRooms;
  private readonly links = new Map<number, MeshLink>();
  /** Peers that announced interest in each room (whether or not we host it). */
  private readonly interest = new Map<string, Set<number>>();
  /** Peers we are responsible for dialing, and their mesh URLs. */
  private readonly dialing = new Map<number, string>();

  constructor(self: number, secret: string, rooms: MeshRooms) {
    this.self = self;
    this.secret = secret;
    this.rooms = rooms;
  }

  /** The agent's list of live servers changed. */
  setPeers(peers: { server: number; meshUrl: string }[]): void {
    const listed = new Set(peers.map((p) => p.server));
    for (const [server, link] of this.links) if (!listed.has(server)) link.close();
    for (const server of this.dialing.keys()) if (!listed.has(server)) this.dialing.delete(server);
    for (const p of peers) {
      if (p.server <= this.self || this.dialing.has(p.server)) continue;
      this.dialing.set(p.server, p.meshUrl);
      this.dial(p.server);
    }
  }

  private dial(server: number): void {
    const meshUrl = this.dialing.get(server);
    if (!meshUrl || this.links.has(server)) return;
    const url = new URL(meshUrl);
    url.searchParams.set("token", serverToken(this.self, this.secret));
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    let handlers: ReturnType<Mesh["attach"]> | null = null;
    ws.addEventListener("open", () => {
      handlers = this.attach(server, { send: (d) => ws.send(d), close: () => ws.close() });
    });
    ws.addEventListener("message", (e) => {
      if (e.data instanceof ArrayBuffer) handlers?.message(new Uint8Array(e.data));
    });
    ws.addEventListener("close", () => {
      handlers?.close();
      if (this.dialing.has(server)) setTimeout(() => this.dial(server), REDIAL_MS);
    });
    ws.addEventListener("error", () => {
      // "close" follows and schedules the redial.
    });
  }

  /**
   * A link to `server` is up (we dialed it, or it dialed our /mesh endpoint).
   * The caller forwards binary frames and the close event to the returned handlers.
   */
  attach(server: number, link: MeshLink): { message(data: Uint8Array): void; close(): void } {
    this.links.get(server)?.close();
    this.links.set(server, link);
    console.log(`mesh: linked to server ${server}`);
    for (const room of this.rooms.names()) link.send(encodeMesh({ t: "interest", room, on: true }));
    return {
      message: (data) => {
        const msg = decodeMesh(data);
        if (msg) this.onMessage(server, msg);
      },
      close: () => {
        if (this.links.get(server) !== link) return;
        this.links.delete(server);
        console.warn(`mesh: lost server ${server}`);
        for (const peers of this.interest.values()) peers.delete(server);
        for (const room of this.rooms.names()) this.rooms.get(room)?.dropOwner(server);
      },
    };
  }

  private onMessage(server: number, msg: MeshMessage): void {
    const room = this.rooms.get(msg.room);
    switch (msg.t) {
      case "interest": {
        let peers = this.interest.get(msg.room);
        if (msg.on) {
          if (!peers) this.interest.set(msg.room, (peers = new Set()));
          peers.add(server);
          // A peer started hosting a room we host: give it our players.
          if (room) this.links.get(server)?.send(encodeMesh({ t: "room_state", room: msg.room, players: room.localState() }));
        } else {
          peers?.delete(server);
          if (peers?.size === 0) this.interest.delete(msg.room);
          room?.dropOwner(server);
        }
        break;
      }
      case "room_state":
        for (const p of msg.players) room?.remoteJoined(server, p);
        break;
      case "joined":
        room?.remoteJoined(server, msg.player);
        break;
      case "left":
        room?.remoteLeft(server, msg.id);
        break;
      case "moves":
        room?.remoteMoves(server, msg.players);
        break;
      case "chat":
        room?.remoteChat(msg.message);
        break;
    }
  }

  /** We started hosting `room`: peers hosting it answer with their players. */
  roomOpened(room: string): void {
    this.broadcastAll({ t: "interest", room, on: true });
  }

  roomClosed(room: string): void {
    this.broadcastAll({ t: "interest", room, on: false });
  }

  /** Where a room sends its local players' events: every peer hosting the same room. */
  syncFor(room: string): RoomSync {
    const send = (msg: MeshMessage) => {
      const peers = this.interest.get(room);
      if (!peers || peers.size === 0) return;
      const data = encodeMesh(msg);
      for (const server of peers) this.links.get(server)?.send(data);
    };
    return {
      joined: (player) => send({ t: "joined", room, player }),
      left: (id) => send({ t: "left", room, id }),
      moves: (players) => send({ t: "moves", room, players }),
      chat: (message) => send({ t: "chat", room, message }),
    };
  }

  private broadcastAll(msg: MeshMessage): void {
    const data = encodeMesh(msg);
    for (const link of this.links.values()) link.send(data);
  }
}
