import type { CollisionMap } from "../../shared/src/collision.ts";
import { recordTick } from "./stats.ts";
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
  type PlayerState,
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

/**
 * Cluster: where the room sends what happens to its *local* players so servers
 * hosting the same room can mirror them (docs/cluster.md "Mesh sync").
 */
export interface RoomSync {
  joined(player: PlayerInfo): void;
  left(id: number): void;
  /** Local players that changed during one tick. */
  moves(players: PlayerState[]): void;
  chat(message: ChatMessage): void;
}

interface Player {
  id: number;
  /** null: this server holds the player's socket and is authoritative. Else the owning server. */
  owner: number | null;
  /** The socket, for local players only. */
  peer: Peer | null;
  name: string;
  character: CharacterId;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
  lastMoveAt: number;
  chatTimes: number[];
}

export interface RoomOptions {
  map: CollisionMap;
  /** Called when the last connection closes; the owner drops the room. */
  onEmpty(): void;
  /** Native fan-out (Bun topic); without it broadcasts loop over peers. */
  publish?: Publish | null;
  /** Cluster: report local players to the agent. */
  onJoined?(player: number): void;
  onLeft?(player: number): void;
  /** Cluster: mirror local players to other servers hosting this room. */
  sync?: RoomSync;
  /** Cluster: chat ids are `chatIdBase | counter` (serverId << 24) so servers never collide. */
  chatIdBase?: number;
  /**
   * Standalone keeps the last messages for newcomers. Cluster mode keeps none
   * (future: chat history in a separate database service, docs/cluster.md).
   */
  keepChatHistory?: boolean;
}

export class Room {
  readonly id: string;
  /** Local players and replicas of players connected to other servers. */
  private readonly players = new Map<number, Player>();
  private localCount = 0;
  private readonly chat: ChatMessage[] = [];
  /** Open sockets, including ones that have not joined yet. */
  private connections = 0;
  private nextPlayerId = 1;
  private nextChatId = 1;
  /** Players (local or replicated) whose position or motion changed since the last snapshot. */
  private readonly changed = new Set<Player>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly map: CollisionMap;
  private readonly publish: Publish | null;
  private readonly opts: RoomOptions;

  constructor(id: string, opts: RoomOptions) {
    this.id = id;
    this.map = opts.map;
    this.publish = opts.publish ?? null;
    this.opts = opts;
  }

  /** Players connected to this server (replicas excluded). */
  get playerCount(): number {
    return this.localCount;
  }

  /** Ids of players connected to this server. */
  playerIds(): number[] {
    return [...this.players.values()].filter((p) => p.owner === null).map((p) => p.id);
  }

  /** Full state of the local players, for a peer that starts mirroring this room. */
  localState(): PlayerInfo[] {
    return [...this.players.values()].filter((p) => p.owner === null).map(toInfo);
  }

  /**
   * Add a freshly upgraded connection; it becomes a player once it sends "join".
   * `playerId` is the id from the agent's ticket in cluster mode.
   * The runtime adapter must call the returned handlers for binary messages and on close.
   */
  accept(peer: Peer, playerId?: number): PeerEvents {
    let player: Player | null = null;
    this.connections++;

    return {
      message: (data) => {
        const msg = decodeClientMessage(data);
        if (!msg) return;
        if (msg.t === "move" && player) {
          this.handleMove(player, msg);
        } else if (msg.t === "join" && !player) {
          player = this.join(peer, msg.name, msg.character, playerId);
        } else if (msg.t === "chat" && player) {
          this.handleChat(player, msg.text);
        }
      },
      close: () => {
        if (player) this.leave(player);
        if (--this.connections === 0) {
          this.stopTicker();
          this.opts.onEmpty();
        }
      },
    };
  }

  // ------------------------------------------------------------ remote (mesh) side

  /** A player of another server appeared (or its full state arrived). */
  remoteJoined(owner: number, info: PlayerInfo): void {
    const existing = this.players.get(info.id);
    if (existing?.owner === null) return; // ours; a stale message
    const player: Player = { ...info, owner, peer: null, lastMoveAt: Date.now(), chatTimes: [] };
    this.players.set(info.id, player);
    if (existing) {
      // Already shown to our clients: refresh its state instead of a second join.
      this.changed.add(player);
      this.changed.delete(existing);
    } else {
      this.broadcast({ t: "player_joined", player: info });
    }
  }

  remoteLeft(owner: number, id: number): void {
    const p = this.players.get(id);
    if (!p || p.owner !== owner) return;
    this.players.delete(id);
    this.changed.delete(p);
    this.broadcast({ t: "player_left", id });
  }

  /** Replicated moves go out to our clients with our next tick. */
  remoteMoves(owner: number, states: PlayerState[]): void {
    for (const s of states) {
      const p = this.players.get(s.id);
      if (!p || p.owner !== owner) continue;
      p.x = s.x;
      p.y = s.y;
      p.dir = s.dir;
      p.moving = s.moving;
      this.changed.add(p);
    }
  }

  remoteChat(message: ChatMessage): void {
    this.broadcast({ t: "chat", message });
  }

  /** A server went away: its players leave this room for our clients. */
  dropOwner(owner: number): void {
    for (const p of [...this.players.values()]) if (p.owner === owner) this.remoteLeft(owner, p.id);
  }

  // ------------------------------------------------------------ local side

  private join(peer: Peer, rawName: unknown, character: unknown, assignedId?: number): Player | null {
    const name = typeof rawName === "string" ? rawName.trim().slice(0, MAX_NAME_LENGTH) : "";
    if (!name || !isCharacterId(character)) {
      send(peer, { t: "error", message: "Invalid name or character." });
      peer.close();
      return null;
    }
    if (assignedId !== undefined && this.players.get(assignedId)?.owner === null) {
      send(peer, { t: "error", message: "This seat is already taken; please rejoin." });
      peer.close();
      return null;
    }
    const id = assignedId ?? this.nextLocalId();

    const spawn = findSpawn(this.map, collisionOffsetY(character));
    const player: Player = {
      id,
      owner: null,
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

    // A stale replica with our id (its old server lost it) is replaced silently.
    const others = [...this.players.values()].filter((p) => p.id !== id);
    send(peer, { t: "welcome", selfId: player.id, players: [...others, player].map(toInfo), chat: this.chat });
    this.broadcast({ t: "player_joined", player: toInfo(player) });
    // Subscribe after the announcement so the newcomer does not receive its own join.
    if (this.publish) {
      if (!peer.subscribe) throw new Error("Room uses publish but the peer cannot subscribe");
      peer.subscribe();
    }
    this.players.set(player.id, player);
    this.localCount++;
    this.startTicker();
    this.opts.onJoined?.(player.id);
    this.opts.sync?.joined(toInfo(player));
    return player;
  }

  /** Standalone ids: a per-room counter that skips ids still in use. */
  private nextLocalId(): number {
    for (;;) {
      if (this.nextPlayerId > 0xffff) this.nextPlayerId = 1;
      const id = this.nextPlayerId++;
      if (!this.players.has(id)) return id;
    }
  }

  private leave(player: Player): void {
    if (this.players.get(player.id) !== player) return;
    this.players.delete(player.id);
    this.localCount--;
    this.changed.delete(player);
    this.broadcast({ t: "player_left", id: player.id });
    this.opts.onLeft?.(player.id);
    this.opts.sync?.left(player.id);
  }

  private handleMove(player: Player, move: { x: number; y: number; dir: Direction; moving: boolean }): void {
    const now = Date.now();
    const elapsed = Math.min((now - player.lastMoveAt) / 1000, 1);
    const maxDistance = MOVE_SPEED * elapsed + MOVE_SLACK;
    const distance = Math.hypot(move.x - player.x, move.y - player.y);

    if (distance > maxDistance || !this.map.canStandAt(move.x, move.y, collisionOffsetY(player.character))) {
      send(player.peer!, { t: "correction", x: player.x, y: player.y });
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
      send(player.peer!, { t: "error", message: "You are sending messages too fast." });
      return;
    }
    player.chatTimes.push(now);

    // Chat ids fit a UInt32: the server's base (serverId * 2^24 in cluster mode) plus a counter.
    const id = (this.opts.chatIdBase ?? 0) + (this.nextChatId++ % 0x1000000);
    const message: ChatMessage = { id, playerId: player.id, name: player.name, text, ts: now };
    if (this.opts.keepChatHistory ?? true) {
      this.chat.push(message);
      if (this.chat.length > CHAT_HISTORY_SIZE) this.chat.shift();
    }
    this.broadcast({ t: "chat", message });
    this.opts.sync?.chat(message);
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
   * Local changes are also mirrored to other servers, once per tick.
   */
  private tick(): void {
    if (this.changed.size === 0) return;
    const start = performance.now();
    const players = [...this.changed];
    this.changed.clear();
    this.broadcast({ t: "snapshot", players });
    if (this.opts.sync) {
      const local = players.filter((p) => p.owner === null);
      if (local.length > 0) this.opts.sync.moves(local.map(toState));
    }
    recordTick(performance.now() - start);
  }

  /** Encode once, send to every local player. */
  private broadcast(msg: ServerMessage): void {
    if (this.localCount === 0) return;
    const data = encodeServerMessage(msg);
    if (this.publish) this.publish(data);
    else for (const p of this.players.values()) p.peer?.send(data);
  }
}

function send(peer: Peer, msg: ServerMessage): void {
  peer.send(encodeServerMessage(msg));
}

function toInfo(p: Player): PlayerInfo {
  return { id: p.id, name: p.name, character: p.character, x: p.x, y: p.y, dir: p.dir, moving: p.moving };
}

function toState(p: Player): PlayerState {
  return { id: p.id, x: p.x, y: p.y, dir: p.dir, moving: p.moving };
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
