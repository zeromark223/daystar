/**
 * What the audience can do without the microphone: react with an emoji, and
 * raise a hand to ask the host for the floor.
 */

/** The reactions on offer; a reaction travels as its index. */
export const REACTIONS = [
  { emoji: "👏", label: "Applause" },
  { emoji: "❤️", label: "Love" },
  { emoji: "😂", label: "Laugh" },
  { emoji: "😮", label: "Wow" },
  { emoji: "🎉", label: "Celebrate" },
  { emoji: "👍", label: "Agree" },
] as const;

/** Per player: a burst of REACTION_BURST, then REACTIONS_PER_SEC. Extra ones are dropped. */
export const REACTION_BURST = 5;
export const REACTIONS_PER_SEC = 2;
/**
 * A snapshot lists at most this many reactions; a room-wide burst of applause
 * beyond that is dropped (it still looks like a crowd clapping) and keeps
 * snapshots small.
 */
export const MAX_REACTIONS_PER_SNAPSHOT = 64;

export interface Reaction {
  id: number;
  kind: number;
}

export function isReactionKind(kind: unknown): kind is number {
  return Number.isInteger(kind) && (kind as number) >= 0 && (kind as number) < REACTIONS.length;
}

/**
 * A raised hand is the moment it went up, in tenths of a second since the epoch
 * (wrapping at 2^32, every 13 years), so the host sees hands in order across
 * servers. 0 means the hand is down.
 */
export function handTicket(now = Date.now()): number {
  return Math.floor(now / 100) % 0x1_0000_0000 || 1;
}

/** A player's hand changed: `hand` is its new ticket, or 0 when lowered. */
export interface HandChange {
  id: number;
  hand: number;
}
