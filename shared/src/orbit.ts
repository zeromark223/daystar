import { MAX_SPEAKERS, WORLD_CENTER } from "./constants.ts";
import { facing, type Direction } from "./direction.ts";

/**
 * Orbit mode: the host gathers everyone around the sun. The server gives each
 * player a seat (a slot) and the moment the orbit started; where a slot is at
 * any time is this file's function, so every client draws the same sky without
 * the server sending a single position while it lasts.
 *
 * Slots 0..STAGE_SLOTS-1 are the stage ring next to the sun, for speakers; the
 * rest fill rings outward, spread evenly around each ring. Outer rings turn
 * slower (Kepler: period grows with radius^1.5).
 */

export const STAGE_SLOTS = MAX_SPEAKERS;
export const STAGE_RADIUS = 420;
export const FIRST_RING = 620;
export const RING_GAP = 80;
/** Room along a ring per player (px). */
export const SEAT_SPACING = 60;
/** The stage ring goes round once in this many seconds. */
export const STAGE_PERIOD_S = 60;
export const NO_SLOT = 0xffff;

export interface Orbit {
  /** Server time it started (Unix ms; modulo 2^32 on the wire). */
  start: number;
  /** Seat of each player by id (the host, in the sun, has none). */
  slots: Map<number, number>;
}

interface Ring {
  radius: number;
  /** Seats on the ring, and where this ring's seats start in slot numbers. */
  capacity: number;
  first: number;
  /** Seats are taken in this order around the ring, so a half-full ring is still even. */
  stride: number;
  phase: number;
  /** Radians per second. */
  speed: number;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

function ring(radius: number, capacity: number, first: number, index: number): Ring {
  let stride = Math.max(1, Math.round(capacity * 0.618));
  while (gcd(stride, capacity) !== 1) stride++;
  const period = STAGE_PERIOD_S * (radius / STAGE_RADIUS) ** 1.5;
  return { radius, capacity, first, stride, phase: index * 0.53, speed: (2 * Math.PI) / period };
}

const STAGE = ring(STAGE_RADIUS, STAGE_SLOTS, 0, 0);
/** Seat rings, built outward as far as needed. */
const rings: Ring[] = [];

function ringFor(slot: number): Ring {
  if (slot < STAGE_SLOTS) return STAGE;
  for (;;) {
    const last = rings.at(-1);
    if (last && slot < last.first + last.capacity) break;
    const index = rings.length;
    const radius = FIRST_RING + index * RING_GAP;
    const capacity = Math.floor((2 * Math.PI * radius) / SEAT_SPACING);
    rings.push(ring(radius, capacity, last ? last.first + last.capacity : STAGE_SLOTS, index + 1));
  }
  // Rings only grow outward, so a binary search would do; there are a few dozen.
  for (const r of rings) if (slot < r.first + r.capacity) return r;
  throw new Error("unreachable");
}

/** Where seat `slot` is `seconds` after the orbit started, and which way it faces. */
export function orbitPosition(slot: number, seconds: number): { x: number; y: number; dir: Direction } {
  const r = ringFor(slot);
  const seat = ((slot - r.first) * r.stride) % r.capacity;
  const angle = r.phase + (2 * Math.PI * seat) / r.capacity + r.speed * seconds;
  const x = WORLD_CENTER.x + Math.cos(angle) * r.radius;
  const y = WORLD_CENTER.y + Math.sin(angle) * r.radius;
  // Moving clockwise on screen: along (-sin, cos).
  return { x, y, dir: facing(-Math.sin(angle), Math.cos(angle), "south") };
}

/** The lowest free seat for a role: the stage for speakers (if one is free), the rings otherwise. */
export function freeSlot(speaker: boolean, used: Iterable<number>): number {
  const taken = new Set(used);
  if (speaker) {
    for (let s = 0; s < STAGE_SLOTS; s++) if (!taken.has(s)) return s;
  }
  for (let s = STAGE_SLOTS; s < NO_SLOT; s++) if (!taken.has(s)) return s;
  return NO_SLOT;
}
