import { DIRECTIONS, type CharacterId, type Direction } from "./characters.ts";

// JSON messages travel as text frames; high-frequency position data travels
// as small binary frames (see encode/decode helpers below).

export interface PlayerInfo {
  id: number;
  name: string;
  character: CharacterId;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
}

export interface ChatMessage {
  id: number;
  playerId: number;
  name: string;
  text: string;
  /** Unix epoch milliseconds. */
  ts: number;
}

export type ClientMessage =
  | { t: "join"; name: string; character: CharacterId }
  | { t: "chat"; text: string };

export type ServerMessage =
  | { t: "welcome"; selfId: number; players: PlayerInfo[]; chat: ChatMessage[] }
  | { t: "player_joined"; player: PlayerInfo }
  | { t: "player_left"; id: number }
  | { t: "chat"; message: ChatMessage }
  | { t: "correction"; x: number; y: number }
  | { t: "error"; message: string };

export interface PlayerState {
  id: number;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
}

const OP_MOVE = 1;
const OP_SNAPSHOT = 2;

const MOVE_SIZE = 1 + 4 + 4 + 1 + 1;
const SNAPSHOT_ENTRY_SIZE = 2 + 4 + 4 + 1 + 1;

function dirIndex(dir: Direction): number {
  return DIRECTIONS.indexOf(dir);
}

function dirFromIndex(i: number): Direction | undefined {
  return DIRECTIONS[i];
}

/** Client -> server: the local player's current position. */
export function encodeMove(x: number, y: number, dir: Direction, moving: boolean): ArrayBuffer {
  const buf = new ArrayBuffer(MOVE_SIZE);
  const v = new DataView(buf);
  v.setUint8(0, OP_MOVE);
  v.setFloat32(1, x);
  v.setFloat32(5, y);
  v.setUint8(9, dirIndex(dir));
  v.setUint8(10, moving ? 1 : 0);
  return buf;
}

export function decodeMove(v: DataView): Omit<PlayerState, "id"> | null {
  if (v.byteLength !== MOVE_SIZE || v.getUint8(0) !== OP_MOVE) return null;
  const x = v.getFloat32(1);
  const y = v.getFloat32(5);
  const dir = dirFromIndex(v.getUint8(9));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !dir) return null;
  return { x, y, dir, moving: v.getUint8(10) === 1 };
}

/** Server -> client: positions of every player in the room. */
export function encodeSnapshot(players: readonly PlayerState[]): Uint8Array {
  const buf = new Uint8Array(3 + players.length * SNAPSHOT_ENTRY_SIZE);
  const v = new DataView(buf.buffer);
  v.setUint8(0, OP_SNAPSHOT);
  v.setUint16(1, players.length);
  let o = 3;
  for (const p of players) {
    v.setUint16(o, p.id);
    v.setFloat32(o + 2, p.x);
    v.setFloat32(o + 6, p.y);
    v.setUint8(o + 10, dirIndex(p.dir));
    v.setUint8(o + 11, p.moving ? 1 : 0);
    o += SNAPSHOT_ENTRY_SIZE;
  }
  return buf;
}

export function decodeSnapshot(v: DataView): PlayerState[] | null {
  if (v.byteLength < 3 || v.getUint8(0) !== OP_SNAPSHOT) return null;
  const count = v.getUint16(1);
  if (v.byteLength !== 3 + count * SNAPSHOT_ENTRY_SIZE) return null;
  const out: PlayerState[] = [];
  let o = 3;
  for (let i = 0; i < count; i++) {
    out.push({
      id: v.getUint16(o),
      x: v.getFloat32(o + 2),
      y: v.getFloat32(o + 6),
      dir: dirFromIndex(v.getUint8(o + 10)) ?? "south",
      moving: v.getUint8(o + 11) === 1,
    });
    o += SNAPSHOT_ENTRY_SIZE;
  }
  return out;
}
