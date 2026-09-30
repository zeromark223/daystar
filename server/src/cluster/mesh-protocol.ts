import { decode, encode, Type, type Struct } from "../../../shared/src/binary/schema.ts";
import {
  ChatStruct,
  infoFromWire,
  infoToWire,
  PlayerInfoStruct,
  PlayerStateStruct,
  VoiceFrameStruct,
  stateFromWire,
  stateToWire,
  type ChatMessage,
  type PlayerInfo,
  type PlayerState,
  type VoiceFrame,
  type WireInfo,
  type WireState,
} from "../../../shared/src/protocol.ts";
import { roleFromIndex, roleIndex, type Role } from "../../../shared/src/roles.ts";

/**
 * Server-to-server room sync (docs/cluster.md "Mesh sync"): binary frames with
 * the same schema encoder and player/chat layouts as the client protocol.
 * Future: the same message shapes over Redis Streams or Kafka instead of direct sockets.
 */
export type MeshMessage =
  /** The sender gained its first (on) or lost its last (off) local player in `room`. */
  | { t: "interest"; room: string; on: boolean }
  /** All of the sender's local players in `room`, sent when a peer starts mirroring it. */
  | { t: "room_state"; room: string; players: PlayerInfo[] }
  | { t: "joined"; room: string; player: PlayerInfo }
  | { t: "left"; room: string; id: number }
  /** The sender's local players that changed in one tick. */
  | { t: "moves"; room: string; players: PlayerState[] }
  | { t: "chat"; room: string; message: ChatMessage }
  /** Migration: the sender now holds player `id`'s socket and asks for its state. */
  | { t: "takeover"; room: string; id: number }
  /**
   * Reply to takeover: the player's last state, or null if the sender did not
   * have it. The sender now treats the player as a replica of the requester.
   */
  | { t: "handoff"; room: string; id: number; player: PlayerInfo | null }
  /** The sender's player `id` has a new role. */
  | { t: "role"; room: string; id: number; role: Role }
  /** Ask the receiver (the player's server) to change the role of its player `id`. */
  | { t: "set_role"; room: string; id: number; role: Role }
  /** Voice frames from the sender's speakers during one tick. */
  | { t: "voice"; room: string; frames: VoiceFrame[] };

const Op = {
  interest: 100,
  room_state: 101,
  joined: 102,
  left: 103,
  moves: 104,
  chat: 105,
  takeover: 106,
  handoff: 107,
  role: 108,
  set_role: 109,
  voice: 110,
} as const;

const RoleStruct: Struct = { room: Type.String, id: Type.UInt16, role: Type.UInt8 };

const Schemas: Record<number, Struct> = {
  [Op.interest]: { room: Type.String, on: Type.UInt8 },
  [Op.room_state]: { room: Type.String, players: Type.Object16, players_Struct: PlayerInfoStruct },
  [Op.joined]: { room: Type.String, player: Type.Object8, player_Struct: PlayerInfoStruct },
  [Op.left]: { room: Type.String, id: Type.UInt16 },
  [Op.moves]: { room: Type.String, players: Type.Object16, players_Struct: PlayerStateStruct },
  [Op.chat]: { room: Type.String, message: Type.Object8, message_Struct: ChatStruct },
  [Op.takeover]: { room: Type.String, id: Type.UInt16 },
  [Op.handoff]: { room: Type.String, id: Type.UInt16, player: Type.Object8, player_Struct: PlayerInfoStruct },
  [Op.role]: RoleStruct,
  [Op.set_role]: RoleStruct,
  [Op.voice]: { room: Type.String, frames: Type.Object8, frames_Struct: VoiceFrameStruct },
};

export function encodeMesh(msg: MeshMessage): Uint8Array<ArrayBuffer> {
  switch (msg.t) {
    case "interest":
      return encode(Schemas[Op.interest], { room: msg.room, on: msg.on ? 1 : 0 }, Op.interest);
    case "room_state":
      return encode(Schemas[Op.room_state], { room: msg.room, players: msg.players.map(infoToWire) }, Op.room_state);
    case "joined":
      // A one-element Object8 list keeps the nested player layout identical to room_state.
      return encode(Schemas[Op.joined], { room: msg.room, player: [infoToWire(msg.player)] }, Op.joined);
    case "left":
      return encode(Schemas[Op.left], msg, Op.left);
    case "moves":
      return encode(Schemas[Op.moves], { room: msg.room, players: msg.players.map(stateToWire) }, Op.moves);
    case "chat":
      return encode(Schemas[Op.chat], { room: msg.room, message: [msg.message] }, Op.chat);
    case "takeover":
      return encode(Schemas[Op.takeover], msg, Op.takeover);
    case "handoff":
      // Zero or one player.
      return encode(
        Schemas[Op.handoff],
        { room: msg.room, id: msg.id, player: msg.player ? [infoToWire(msg.player)] : [] },
        Op.handoff,
      );
    case "role":
    case "set_role":
      return encode(Schemas[Op[msg.t]], { room: msg.room, id: msg.id, role: roleIndex(msg.role) }, Op[msg.t]);
    case "voice":
      return encode(Schemas[Op.voice], msg, Op.voice);
  }
}

/** null for malformed or unknown frames. */
export function decodeMesh(bytes: Uint8Array): MeshMessage | null {
  try {
    const op = bytes[0];
    const schema = Schemas[op];
    switch (op) {
      case Op.interest: {
        const m = decode<{ room: string; on: number }>(schema, bytes, 1);
        return { t: "interest", room: m.room, on: m.on === 1 };
      }
      case Op.room_state: {
        const m = decode<{ room: string; players: WireInfo[] }>(schema, bytes, 1);
        return { t: "room_state", room: m.room, players: m.players.map(infoFromWire) };
      }
      case Op.joined: {
        const m = decode<{ room: string; player: WireInfo[] }>(schema, bytes, 1);
        return m.player.length === 1 ? { t: "joined", room: m.room, player: infoFromWire(m.player[0]) } : null;
      }
      case Op.left:
        return { t: "left", ...decode<{ room: string; id: number }>(schema, bytes, 1) };
      case Op.moves: {
        const m = decode<{ room: string; players: WireState[] }>(schema, bytes, 1);
        return { t: "moves", room: m.room, players: m.players.map(stateFromWire) };
      }
      case Op.chat: {
        const m = decode<{ room: string; message: ChatMessage[] }>(schema, bytes, 1);
        return m.message.length === 1 ? { t: "chat", room: m.room, message: m.message[0] } : null;
      }
      case Op.takeover:
        return { t: "takeover", ...decode<{ room: string; id: number }>(schema, bytes, 1) };
      case Op.handoff: {
        const m = decode<{ room: string; id: number; player: WireInfo[] }>(schema, bytes, 1);
        if (m.player.length > 1) return null;
        return { t: "handoff", room: m.room, id: m.id, player: m.player[0] ? infoFromWire(m.player[0]) : null };
      }
      case Op.role:
      case Op.set_role: {
        const m = decode<{ room: string; id: number; role: number }>(schema, bytes, 1);
        const role = roleFromIndex(m.role);
        if (!role) return null;
        return { t: op === Op.role ? "role" : "set_role", room: m.room, id: m.id, role };
      }
      case Op.voice:
        return { t: "voice", ...decode<{ room: string; frames: VoiceFrame[] }>(schema, bytes, 1) };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
