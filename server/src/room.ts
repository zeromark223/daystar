import type { CollisionMap } from "../../shared/src/collision.ts";
import {
  CHAT_HISTORY_SIZE,
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  MOVE_SPEED,
  SPAWN_POINT,
  SPAWN_RADIUS,
  TICK_RATE,
} from "../../shared/src/constants.ts";
import { collisionOffsetY, isCharacterId, type CharacterId, type Direction } from "../../shared/src/characters.ts";
import {
  decodeClientMessage,
  encodeServerMessage,
  type ChatMessage,
  type PlayerInfo,
  type ServerMessage,
} from "../../shared/src/protocol.ts";

/** Extra distance tolerated per move to absorb network jitter. */
const MOVE_SLACK = 24;
const CHAT_BURST = 5;
const CHAT_WINDOW_MS = 5000;

/** A connected client, whatever the runtime's WebSocket implementation is. */
export interface Peer {
  send(data: Uint8Array): void;
  close(): void;
  /**
   * Join the room's broadcast channel. Only needed when the room has a
   * `publish` function (Bun topics); called once the player has joined.
   */
  subscribe?(): void;
}

/**
 * Sends one frame to every subscribed peer of a room in a single call
 * (Bun's server.publish fans out natively). Without it the room loops over peers.
 */
export type Publish = (data: Uint8Array) => void;

/** Events the runtime adapter forwards to the room for one peer. */
export interface PeerEvents {
  message(data: Uint8Array): void;
  close(): void;
}

interface Player {
  id: number;
  peer: Peer;
  name: string;
  character: CharacterId;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
  lastMoveAt: number;
  chatTimes: number[];
}

export class Room {
  readonly id: string;
  private readonly players = new Map<number, Player>();
  private readonly chat: ChatMessage[] = [];
  /** Open sockets, including ones that have not joined yet. */
  private connections = 0;
  private nextPlayerId = 1;
  private nextChatId = 1;
  /** Players whose position or motion changed since the last snapshot. */
  private readonly changed = new Set<Player>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly map: CollisionMap;
  private readonly onEmpty: () => void;

  private readonly publish: Publish | null;

  constructor(id: string, map: CollisionMap, onEmpty: () => void, publish: Publish | null = null) {
    this.id = id;
    this.map = map;
    this.onEmpty = onEmpty;
    this.publish = publish;
  }

  get playerCount(): number {
    return this.players.size;
  }

  /**
   * Add a freshly upgraded connection; it becomes a player once it sends "join".
   * The runtime adapter must call the returned handlers for binary messages and on close.
   */
  accept(peer: Peer): PeerEvents {
    let player: Player | null = null;
    this.connections++;

    return {
      message: (data) => {
        const msg = decodeClientMessage(data);
        if (!msg) return;
        if (msg.t === "move" && player) {
          this.handleMove(player, msg);
        } else if (msg.t === "join" && !player) {
          player = this.join(peer, msg.name, msg.character);
        } else if (msg.t === "chat" && player) {
          this.handleChat(player, msg.text);
        }
      },
      close: () => {
        if (player) this.leave(player);
        if (--this.connections === 0) {
          this.stopTicker();
          this.onEmpty();
        }
      },
    };
  }

  private join(peer: Peer, rawName: unknown, character: unknown): Player | null {
    const name = typeof rawName === "string" ? rawName.trim().slice(0, MAX_NAME_LENGTH) : "";
    if (!name || !isCharacterId(character)) {
      send(peer, { t: "error", message: "Invalid name or character." });
      peer.close();
      return null;
    }
    if (this.nextPlayerId > 0xffff) this.nextPlayerId = 1;

    const spawn = findSpawn(this.map, collisionOffsetY(character));
    const player: Player = {
      id: this.nextPlayerId++,
      peer,
      name,
      character,
      x: spawn.x,
      y: spawn.y,
      dir: "south",
      moving: false,
      lastMoveAt: Date.now(),
      chatTimes: [],
    };

    send(peer, {
      t: "welcome",
      selfId: player.id,
      players: [...this.players.values(), player].map(toInfo),
      chat: this.chat,
    });
    this.broadcast({ t: "player_joined", player: toInfo(player) });
    // Subscribe after the announcement so the newcomer does not receive its own join.
    if (this.publish) {
      if (!peer.subscribe) throw new Error("Room uses publish but the peer cannot subscribe");
      peer.subscribe();
    }
    this.players.set(player.id, player);
    this.startTicker();
    return player;
  }

  private leave(player: Player): void {
    this.players.delete(player.id);
    this.changed.delete(player);
    this.broadcast({ t: "player_left", id: player.id });
  }

  private handleMove(player: Player, move: { x: number; y: number; dir: Direction; moving: boolean }): void {
    const now = Date.now();
    const elapsed = Math.min((now - player.lastMoveAt) / 1000, 1);
    const maxDistance = MOVE_SPEED * elapsed + MOVE_SLACK;
    const distance = Math.hypot(move.x - player.x, move.y - player.y);

    if (distance > maxDistance || !this.map.canStandAt(move.x, move.y, collisionOffsetY(player.character))) {
      send(player.peer, { t: "correction", x: player.x, y: player.y });
      return;
    }

    player.x = move.x;
    player.y = move.y;
    player.dir = move.dir;
    player.moving = move.moving;
    player.lastMoveAt = now;
    this.changed.add(player);
  }

  private handleChat(player: Player, rawText: unknown): void {
    if (typeof rawText !== "string") return;
    const text = rawText.trim().slice(0, MAX_CHAT_LENGTH);
    if (!text) return;

    const now = Date.now();
    player.chatTimes = player.chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
    if (player.chatTimes.length >= CHAT_BURST) {
      send(player.peer, { t: "error", message: "You are sending messages too fast." });
      return;
    }
    player.chatTimes.push(now);

    const message: ChatMessage = { id: this.nextChatId++, playerId: player.id, name: player.name, text, ts: now };
    this.chat.push(message);
    if (this.chat.length > CHAT_HISTORY_SIZE) this.chat.shift();
    this.broadcast({ t: "chat", message });
  }

  private startTicker(): void {
    this.ticker ??= setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /**
   * Send only the players that changed; idle players cost nothing. The stream
   * is reliable and ordered, and "welcome" carries everyone's full state, so
   * clients can keep the last known state of anyone missing from a snapshot.
   */
  private tick(): void {
    if (this.changed.size === 0) return;
    const players = [...this.changed];
    this.changed.clear();
    this.broadcast({ t: "snapshot", players });
  }

  /** Encode once, send to every joined player. */
  private broadcast(msg: ServerMessage): void {
    if (this.players.size === 0) return;
    const data = encodeServerMessage(msg);
    if (this.publish) this.publish(data);
    else for (const p of this.players.values()) p.peer.send(data);
  }
}

function send(peer: Peer, msg: ServerMessage): void {
  peer.send(encodeServerMessage(msg));
}

function toInfo(p: Player): PlayerInfo {
  return { id: p.id, name: p.name, character: p.character, x: p.x, y: p.y, dir: p.dir, moving: p.moving };
}

function findSpawn(map: CollisionMap, offsetY: number): { x: number; y: number } {
  for (let i = 0; i < 50; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * SPAWN_RADIUS;
    const x = Math.round(SPAWN_POINT.x + Math.cos(angle) * r);
    const y = Math.round(SPAWN_POINT.y + Math.sin(angle) * r);
    if (map.canStandAt(x, y, offsetY)) return { x, y };
  }
  return { ...SPAWN_POINT };
}
