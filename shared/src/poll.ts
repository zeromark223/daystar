import { WORLD_CENTER } from "./constants.ts";

/**
 * Polls you answer by flying: the host asks a question, each answer is a planet
 * on a ring around the sun, and a player's vote is the planet it is in. The
 * server counts from positions it already has, so voting costs no messages.
 */
export interface Poll {
  id: number;
  question: string;
  options: string[];
  /** False once the host ended it; `counts` are then the final result. */
  open: boolean;
  counts: number[];
}

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 4;
export const POLL_QUESTION_MAX = 100;
export const POLL_OPTION_MAX = 32;
/** Answer planets sit this far from the center of the sun... */
export const POLL_RING = 1_000;
/** ...and count everyone within this radius of their center. */
export const POLL_ZONE_RADIUS = 300;
/** How often the server recounts (players only get new counts when they change). */
export const POLL_COUNT_MS = 500;

/** Centers of the answer planets for `n` options: the first at the top, then clockwise. */
export function pollZones(n: number): { x: number; y: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { x: WORLD_CENTER.x + Math.cos(a) * POLL_RING, y: WORLD_CENTER.y + Math.sin(a) * POLL_RING };
  });
}

const zoneCache = new Map<number, { x: number; y: number }[]>();

/** The answer planet at (x, y) for a poll with `n` options, or -1. */
export function pollZoneAt(x: number, y: number, n: number): number {
  let zones = zoneCache.get(n);
  if (!zones) zoneCache.set(n, (zones = pollZones(n)));
  const r2 = POLL_ZONE_RADIUS * POLL_ZONE_RADIUS;
  for (let i = 0; i < zones.length; i++) {
    const dx = x - zones[i].x;
    const dy = y - zones[i].y;
    if (dx * dx + dy * dy <= r2) return i;
  }
  return -1;
}

/** Trimmed question and options if they make a valid poll, else null. */
export function cleanPoll(question: unknown, options: unknown): { question: string; options: string[] } | null {
  if (typeof question !== "string" || !Array.isArray(options)) return null;
  const q = question.trim().slice(0, POLL_QUESTION_MAX);
  const opts = options.map((o) => (typeof o === "string" ? o.trim().slice(0, POLL_OPTION_MAX) : "")).filter(Boolean);
  if (!q || opts.length < POLL_MIN_OPTIONS || opts.length > POLL_MAX_OPTIONS) return null;
  return { question: q, options: opts };
}
