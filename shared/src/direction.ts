/** Facing of a player; sent with every move (2 bits on the wire). */
export const DIRECTIONS = ["south", "west", "east", "north"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Facing for a movement vector, favoring the dominant axis. */
export function facing(vx: number, vy: number, current: Direction): Direction {
  const ax = Math.abs(vx);
  const ay = Math.abs(vy);
  if (ax > ay) return vx > 0 ? "east" : "west";
  if (ay > ax) return vy > 0 ? "south" : "north";
  if (ax === 0) return current;
  const horizontal = vx > 0 ? "east" : "west";
  const vertical = vy > 0 ? "south" : "north";
  return current === horizontal || current === vertical ? current : vertical;
}
