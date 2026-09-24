import type { WebSocket } from "ws";
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
import { isCharacterId, type CharacterId, type Direction } from "../../shared/src/characters.ts";
import {
  decodeMove,
  encodeSnapshot,
  type ChatMessage,
  type ClientMessage,
  type PlayerInfo,
  type ServerMessage,
} from "../../shared/src/protocol.ts";

/** Extra distance tolerated per move to absorb network jitter. */
const MOVE_SLACK = 24;
const CHAT_BURST = 5;
const CHAT_WINDOW_MS = 5000;

interface Player {
  id: number;
  socket: WebSocket;
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
  private dirty = false;
  private ticker: NodeJS.Timeout | null = null;
  private readonly map: CollisionMap;
  private readonly onEmpty: () => void;

  constructor(id: string, map: CollisionMap, onEmpty: () => void) {
    this.id = id;
    this.map = map;
    this.onEmpty = onEmpty;
  }

  /** Wire a freshly upgraded socket into the room; it becomes a player once it sends "join". */
  accept(socket: WebSocket): void {
    let player: Player | null = null;
    this.connections++;

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        if (player) this.handleMove(player, data as Buffer);
        return;
      }
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t === "join" && !player) {
        player = this.join(socket, msg.name, msg.character);
      } else if (msg.t === "chat" && player) {
        this.handleChat(player, msg.text);
      }
    });

    socket.on("close", () => {
      if (player) this.leave(player);
      if (--this.connections === 0) {
        this.stopTicker();
        this.onEmpty();
      }
    });
  }

  private join(socket: WebSocket, rawName: unknown, character: unknown): Player | null {
    const name = typeof rawName === "string" ? rawName.trim().slice(0, MAX_NAME_LENGTH) : "";
    if (!name || !isCharacterId(character)) {
      send(socket, { t: "error", message: "Invalid name or character." });
      socket.close();
      return null;
    }
    if (this.nextPlayerId > 0xffff) this.nextPlayerId = 1;

    const spawn = findSpawn(this.map);
    const player: Player = {
      id: this.nextPlayerId++,
      socket,
      name,
      character,
      x: spawn.x,
      y: spawn.y,
      dir: "south",
      moving: false,
      lastMoveAt: Date.now(),
      chatTimes: [],
    };

    send(socket, {
      t: "welcome",
      selfId: player.id,
      players: [...this.players.values(), player].map(toInfo),
      chat: this.chat,
    });
    this.broadcast({ t: "player_joined", player: toInfo(player) });
    this.players.set(player.id, player);
    this.startTicker();
    return player;
  }

  private leave(player: Player): void {
    this.players.delete(player.id);
    this.broadcast({ t: "player_left", id: player.id });
  }

  private handleMove(player: Player, data: Buffer): void {
    const move = decodeMove(new DataView(data.buffer, data.byteOffset, data.byteLength));
    if (!move) return;

    const now = Date.now();
    const elapsed = Math.min((now - player.lastMoveAt) / 1000, 1);
    const maxDistance = MOVE_SPEED * elapsed + MOVE_SLACK;
    const distance = Math.hypot(move.x - player.x, move.y - player.y);

    if (distance > maxDistance || !this.map.canStandAt(move.x, move.y)) {
      send(player.socket, { t: "correction", x: player.x, y: player.y });
      return;
    }

    player.x = move.x;
    player.y = move.y;
    player.dir = move.dir;
    player.moving = move.moving;
    player.lastMoveAt = now;
    this.dirty = true;
  }

  private handleChat(player: Player, rawText: unknown): void {
    if (typeof rawText !== "string") return;
    const text = rawText.trim().slice(0, MAX_CHAT_LENGTH);
    if (!text) return;

    const now = Date.now();
    player.chatTimes = player.chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
    if (player.chatTimes.length >= CHAT_BURST) {
      send(player.socket, { t: "error", message: "You are sending messages too fast." });
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

  private tick(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const snapshot = encodeSnapshot([...this.players.values()]);
    for (const p of this.players.values()) p.socket.send(snapshot);
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) p.socket.send(data);
  }
}

function send(socket: WebSocket, msg: ServerMessage): void {
  socket.send(JSON.stringify(msg));
}

function toInfo(p: Player): PlayerInfo {
  return { id: p.id, name: p.name, character: p.character, x: p.x, y: p.y, dir: p.dir, moving: p.moving };
}

function findSpawn(map: CollisionMap): { x: number; y: number } {
  for (let i = 0; i < 50; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * SPAWN_RADIUS;
    const x = Math.round(SPAWN_POINT.x + Math.cos(angle) * r);
    const y = Math.round(SPAWN_POINT.y + Math.sin(angle) * r);
    if (map.canStandAt(x, y)) return { x, y };
  }
  return { ...SPAWN_POINT };
}
