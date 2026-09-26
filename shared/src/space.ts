import { FADE_START, SPAWN_NEAR, SPAWN_RING, SUN_RADIUS, WORLD_CENTER, WORLD_RADIUS } from "./constants.ts";

/**
 * The shape of the world, shared by client prediction and server validation:
 * players live in the ring between the sun and the edge of the disc.
 */

/** Allowance for positions that were rounded to the wire grid. */
const EPSILON = 0.5;
/** Constrained positions stay this far inside the limits so rounding cannot cross them. */
const MARGIN = 1;

export function distanceFromCenter(x: number, y: number): number {
  return Math.hypot(x - WORLD_CENTER.x, y - WORLD_CENTER.y);
}

/** Whether a player may be at (x, y): outside the sun, inside the world. */
export function canBeAt(x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const r = distanceFromCenter(x, y);
  return r >= SUN_RADIUS - EPSILON && r <= WORLD_RADIUS + EPSILON;
}

/** The nearest allowed position; players slide along the sun and the edge. */
export function constrain(x: number, y: number): { x: number; y: number } {
  const dx = x - WORLD_CENTER.x;
  const dy = y - WORLD_CENTER.y;
  const r = Math.hypot(dx, dy);
  const limit = r > WORLD_RADIUS - MARGIN ? WORLD_RADIUS - MARGIN : r < SUN_RADIUS + MARGIN ? SUN_RADIUS + MARGIN : r;
  if (limit === r) return { x, y };
  // Exactly at the center there is no direction to push along; pick one.
  const ux = r === 0 ? 1 : dx / r;
  const uy = r === 0 ? 0 : dy / r;
  return { x: WORLD_CENTER.x + ux * limit, y: WORLD_CENTER.y + uy * limit };
}

export function moveInSpace(x: number, y: number, dx: number, dy: number): { x: number; y: number } {
  return constrain(x + dx, y + dy);
}

/**
 * How bright a player is drawn: 1 until FADE_START of the radius, then fading
 * linearly to 0 (invisible) at the edge of the world.
 */
export function brightnessAt(x: number, y: number): number {
  const t = distanceFromCenter(x, y) / WORLD_RADIUS;
  if (t <= FADE_START) return 1;
  return Math.max(0, (1 - t) / (1 - FADE_START));
}

/**
 * Where a newcomer appears: near a random player already in the room so people
 * find each other, or on a ring around the sun when the room is empty.
 */
export function spawnPoint(others: readonly { x: number; y: number }[], random = Math.random): { x: number; y: number } {
  const angle = random() * Math.PI * 2;
  if (others.length > 0) {
    const near = others[Math.floor(random() * others.length)];
    const d = SPAWN_NEAR.min + random() * (SPAWN_NEAR.max - SPAWN_NEAR.min);
    return constrain(near.x + Math.cos(angle) * d, near.y + Math.sin(angle) * d);
  }
  const d = SPAWN_RING.min + random() * (SPAWN_RING.max - SPAWN_RING.min);
  return { x: WORLD_CENTER.x + Math.cos(angle) * d, y: WORLD_CENTER.y + Math.sin(angle) * d };
}
