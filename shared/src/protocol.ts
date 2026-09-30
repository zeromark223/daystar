import { decode, encode, Type, type Struct } from "./binary/schema.ts";
import { isAppearanceId, type AppearanceId } from "./appearance.ts";
import { DIRECTIONS, type Direction } from "./direction.ts";
import { roleFromIndex, roleIndex, type Role } from "./roles.ts";

// Every frame is binary: one opcode byte, then the message body laid out by
// its schema (see ./binary/schema.ts).

export interface PlayerInfo {
  id: number;
  name: string;
  appearance: AppearanceId;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
  role: Role;
}

export interface PlayerState {
  id: number;
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

/** One Opus frame (VOICE_FRAME_MS of audio) from a host or speaker. */
export interface VoiceFrame {
  /** The speaking player. */
  id: number;
  /** Per-speaker counter (wraps at 65536); gaps mean silence or dropped frames. */
  seq: number;
  data: Uint8Array;
}

export type ClientMessage =
  /** `hostKey` is empty for guests; the room's host key makes the sender the host. */
  | { t: "join"; name: string; appearance: AppearanceId; hostKey: string }
  | { t: "chat"; text: string }
  | { t: "move"; x: number; y: number; dir: Direction; moving: boolean }
  /** Host only: make a player a speaker or a guest again. */
  | { t: "set_role"; id: number; role: "speaker" | "guest" }
  /** Host and speakers only: one encoded frame from the microphone. */
  | { t: "voice"; seq: number; data: Uint8Array };

export type ServerMessage =
  | { t: "welcome"; selfId: number; players: PlayerInfo[]; chat: ChatMessage[] }
  | { t: "player_joined"; player: PlayerInfo }
  | { t: "player_left"; id: number }
  | { t: "chat"; message: ChatMessage }
  | { t: "correction"; x: number; y: number }
  | { t: "error"; message: string }
  /** Once per tick: players that changed, and voice frames received since the last tick. */
  | { t: "snapshot"; players: PlayerState[]; voice: VoiceFrame[] }
  | { t: "role"; id: number; role: Role }
  /** Cluster: reconnect elsewhere (ask the agent's /api/migrate); the server is shedding load. */
  | { t: "migrate" };

// ------------------------------------------------------------------ positions

/**
 * Positions travel as UInt16 in 1/POSITION_SCALE px steps (max 16383 px, enough
 * for the 10000 px world). The client snaps its own position to the same grid so
 * what the server validates is exactly what the client simulated.
 */
export const POSITION_SCALE = 4;

export function quantize(v: number): number {
  return Math.round(v * POSITION_SCALE) / POSITION_SCALE;
}

const toWire = (v: number) => Math.max(0, Math.min(0xffff, Math.round(v * POSITION_SCALE)));
const fromWire = (v: number) => v / POSITION_SCALE;

/** Direction index in bits 0-1, moving flag in bit 2. */
function packMotion(dir: Direction, moving: boolean): number {
  return DIRECTIONS.indexOf(dir) | (moving ? 4 : 0);
}

function unpackMotion(bits: number): { dir: Direction; moving: boolean } {
  return { dir: DIRECTIONS[bits & 3], moving: (bits & 4) !== 0 };
}

// ------------------------------------------------------------------ schemas

export const PlayerStateStruct: Struct = { id: Type.UInt16, x: Type.UInt16, y: Type.UInt16, motion: Type.UInt8 };
export const PlayerInfoStruct: Struct = {
  ...PlayerStateStruct,
  name: Type.String,
  appearance: Type.UInt8,
  role: Type.UInt8,
};
export const VoiceFrameStruct: Struct = { id: Type.UInt16, seq: Type.UInt16, data: Type.Bytes };
export const ChatStruct: Struct = {
  id: Type.UInt32,
  playerId: Type.UInt16,
  name: Type.String,
  text: Type.String,
  ts: Type.Double,
};

const Op = {
  // client -> server
  join: 1,
  chat: 2,
  move: 3,
  set_role: 4,
  voice: 5,
  // server -> client
  welcome: 10,
  player_joined: 11,
  player_left: 12,
  server_chat: 13,
  correction: 14,
  error: 15,
  snapshot: 16,
  migrate: 17,
  role: 18,
} as const;

/** Opcode of server snapshots, for callers that only need to recognize them. */
export const SNAPSHOT_OPCODE = Op.snapshot;

const Schemas: Record<number, Struct> = {
  [Op.join]: { name: Type.String, appearance: Type.UInt8, hostKey: Type.String },
  [Op.chat]: { text: Type.String },
  [Op.move]: { x: Type.UInt16, y: Type.UInt16, motion: Type.UInt8 },
  [Op.set_role]: { id: Type.UInt16, role: Type.UInt8 },
  [Op.voice]: { seq: Type.UInt16, data: Type.Bytes },
  [Op.welcome]: {
    selfId: Type.UInt16,
    players: Type.Object16,
    players_Struct: PlayerInfoStruct,
    chat: Type.Object8,
    chat_Struct: ChatStruct,
  },
  [Op.player_joined]: PlayerInfoStruct,
  [Op.player_left]: { id: Type.UInt16 },
  [Op.server_chat]: ChatStruct,
  [Op.correction]: { x: Type.UInt16, y: Type.UInt16 },
  [Op.error]: { message: Type.String },
  [Op.snapshot]: {
    players: Type.Object16,
    players_Struct: PlayerStateStruct,
    voice: Type.Object8,
    voice_Struct: VoiceFrameStruct,
  },
  [Op.migrate]: {},
  [Op.role]: { id: Type.UInt16, role: Type.UInt8 },
};

// ------------------------------------------------------------------ wire <-> message

export interface WireState {
  id: number;
  x: number;
  y: number;
  motion: number;
}

export interface WireInfo extends WireState {
  name: string;
  appearance: number;
  role: number;
}

export function stateToWire(p: PlayerState): WireState {
  return { id: p.id, x: toWire(p.x), y: toWire(p.y), motion: packMotion(p.dir, p.moving) };
}

export function stateFromWire(w: WireState): PlayerState {
  return { id: w.id, x: fromWire(w.x), y: fromWire(w.y), ...unpackMotion(w.motion) };
}

export function infoToWire(p: PlayerInfo): WireInfo {
  return { ...stateToWire(p), name: p.name, appearance: p.appearance, role: roleIndex(p.role) };
}

export function infoFromWire(w: WireInfo): PlayerInfo {
  if (!isAppearanceId(w.appearance)) throw new RangeError("Unknown appearance");
  const role = roleFromIndex(w.role);
  if (!role) throw new RangeError("Unknown role");
  return { ...stateFromWire(w), name: w.name, appearance: w.appearance, role };
}

export function encodeClientMessage(msg: ClientMessage): Uint8Array<ArrayBuffer> {
  switch (msg.t) {
    case "join":
      return encode(Schemas[Op.join], { name: msg.name, appearance: msg.appearance, hostKey: msg.hostKey }, Op.join);
    case "chat":
      return encode(Schemas[Op.chat], msg, Op.chat);
    case "move":
      return encode(
        Schemas[Op.move],
        { x: toWire(msg.x), y: toWire(msg.y), motion: packMotion(msg.dir, msg.moving) },
        Op.move,
      );
    case "set_role":
      return encode(Schemas[Op.set_role], { id: msg.id, role: roleIndex(msg.role) }, Op.set_role);
    case "voice":
      return encode(Schemas[Op.voice], msg, Op.voice);
  }
}

/** Returns null for malformed or unknown frames (client input is untrusted). */
export function decodeClientMessage(bytes: Uint8Array): ClientMessage | null {
  try {
    const op = bytes[0];
    switch (op) {
      case Op.join: {
        const m = decode<{ name: string; appearance: number; hostKey: string }>(Schemas[op], bytes, 1);
        if (!isAppearanceId(m.appearance)) return null;
        return { t: "join", name: m.name, appearance: m.appearance, hostKey: m.hostKey };
      }
      case Op.chat:
        return { t: "chat", ...decode<{ text: string }>(Schemas[op], bytes, 1) };
      case Op.move: {
        const m = decode<{ x: number; y: number; motion: number }>(Schemas[op], bytes, 1);
        if (m.motion > 7) return null;
        return { t: "move", x: fromWire(m.x), y: fromWire(m.y), ...unpackMotion(m.motion) };
      }
      case Op.set_role: {
        const m = decode<{ id: number; role: number }>(Schemas[op], bytes, 1);
        const role = roleFromIndex(m.role);
        return role === "speaker" || role === "guest" ? { t: "set_role", id: m.id, role } : null;
      }
      case Op.voice:
        return { t: "voice", ...decode<{ seq: number; data: Uint8Array }>(Schemas[op], bytes, 1) };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function encodeServerMessage(msg: ServerMessage): Uint8Array<ArrayBuffer> {
  switch (msg.t) {
    case "welcome":
      return encode(
        Schemas[Op.welcome],
        { selfId: msg.selfId, players: msg.players.map(infoToWire), chat: msg.chat },
        Op.welcome,
      );
    case "player_joined":
      return encode(Schemas[Op.player_joined], infoToWire(msg.player), Op.player_joined);
    case "player_left":
      return encode(Schemas[Op.player_left], msg, Op.player_left);
    case "chat":
      return encode(Schemas[Op.server_chat], msg.message, Op.server_chat);
    case "correction":
      return encode(Schemas[Op.correction], { x: toWire(msg.x), y: toWire(msg.y) }, Op.correction);
    case "error":
      return encode(Schemas[Op.error], msg, Op.error);
    case "snapshot":
      return encode(Schemas[Op.snapshot], { players: msg.players.map(stateToWire), voice: msg.voice }, Op.snapshot);
    case "migrate":
      return encode(Schemas[Op.migrate], {}, Op.migrate);
    case "role":
      return encode(Schemas[Op.role], { id: msg.id, role: roleIndex(msg.role) }, Op.role);
  }
}

export function decodeServerMessage(bytes: Uint8Array): ServerMessage | null {
  try {
    const op = bytes[0];
    const schema = Schemas[op];
    switch (op) {
      case Op.welcome: {
        const m = decode<{ selfId: number; players: WireInfo[]; chat: ChatMessage[] }>(schema, bytes, 1);
        return { t: "welcome", selfId: m.selfId, players: m.players.map(infoFromWire), chat: m.chat };
      }
      case Op.player_joined:
        return { t: "player_joined", player: infoFromWire(decode<WireInfo>(schema, bytes, 1)) };
      case Op.player_left:
        return { t: "player_left", ...decode<{ id: number }>(schema, bytes, 1) };
      case Op.server_chat:
        return { t: "chat", message: decode<ChatMessage>(schema, bytes, 1) };
      case Op.correction: {
        const m = decode<{ x: number; y: number }>(schema, bytes, 1);
        return { t: "correction", x: fromWire(m.x), y: fromWire(m.y) };
      }
      case Op.error:
        return { t: "error", ...decode<{ message: string }>(schema, bytes, 1) };
      case Op.snapshot: {
        const m = decode<{ players: WireState[]; voice: VoiceFrame[] }>(schema, bytes, 1);
        return { t: "snapshot", players: m.players.map(stateFromWire), voice: m.voice };
      }
      case Op.migrate:
        decode(schema, bytes, 1);
        return { t: "migrate" };
      case Op.role: {
        const m = decode<{ id: number; role: number }>(schema, bytes, 1);
        const role = roleFromIndex(m.role);
        return role ? { t: "role", id: m.id, role } : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
