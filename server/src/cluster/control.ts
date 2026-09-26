import type { StatsSample } from "../stats.ts";

/**
 * Control channel between a game server and the agent: JSON over the agent's
 * internal WebSocket (/internal). Low rate, so readability beats compactness.
 */

export interface ServerInfo {
  server: number;
  /** WebSocket URL clients connect to, e.g. wss://s1.talk.ptnn.dev/ws. */
  publicUrl: string;
  /** WebSocket URL other servers connect to for room sync. */
  meshUrl: string;
  /** Players at 100% load. */
  capacity: number;
}

export type ServerToAgent =
  /** First message after connecting (and after reconnecting): who we are and who is here. */
  | ({ t: "register"; players: { room: string; player: number }[] } & ServerInfo)
  | { t: "joined"; room: string; player: number }
  | { t: "left"; room: string; player: number }
  /** The server asked this player to migrate (after a move order); lets /api/migrate accept it. */
  | { t: "migrating"; room: string; player: number }
  | { t: "stats"; sample: StatsSample };

export type AgentToServer =
  /** Every live server; each server keeps a mesh connection to the others. */
  | { t: "peers"; peers: { server: number; meshUrl: string }[] }
  /** Ask the server to send `count` players of `room` elsewhere (migration). */
  | { t: "move"; room: string; count: number };
