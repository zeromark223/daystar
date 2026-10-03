import { AOI_CELL, AOI_FOG_END, AOI_FOG_START, AOI_RADIUS } from "./constants.ts";

/**
 * Area of interest on a grid of AOI_CELL squares. The server sends each cell's
 * viewers the moves of everyone close enough to the cell's center that they might
 * be within AOI_RADIUS of a viewer anywhere in the cell.
 */

const ROW = 64; // cells per row in a key; the 10,000 px world needs 27

export function cellOf(x: number, y: number): number {
  const cx = Math.min(ROW - 1, Math.max(0, Math.floor(x / AOI_CELL)));
  const cy = Math.max(0, Math.floor(y / AOI_CELL));
  return cy * ROW + cx;
}

function center(cell: number): { x: number; y: number } {
  return { x: ((cell % ROW) + 0.5) * AOI_CELL, y: (Math.floor(cell / ROW) + 0.5) * AOI_CELL };
}

/** From a cell's center: AOI_RADIUS plus the farthest a viewer can be inside the cell. */
export const VIEW_REACH = AOI_RADIUS + AOI_CELL * Math.SQRT1_2;

/** Whether a player at (x, y) is in view of the viewers of `cell`. */
export function inView(x: number, y: number, cell: number): boolean {
  const c = center(cell);
  return Math.hypot(x - c.x, y - c.y) <= VIEW_REACH;
}

/** Cheap pre-check: whether any point of `other` can be in view of `cell`. */
export function cellsMeet(cell: number, other: number): boolean {
  const a = center(cell);
  const b = center(other);
  return Math.hypot(a.x - b.x, a.y - b.y) <= VIEW_REACH + AOI_CELL * Math.SQRT1_2;
}

const ROWS = 32; // the world's 10,000 px need 27
const neighbours = new Map<number, number[]>();
const neighbourSets = new Map<number, Set<number>>();

/** cellsInView as a set, for membership tests. */
export function cellSetInView(cell: number): Set<number> {
  let set = neighbourSets.get(cell);
  if (!set) neighbourSets.set(cell, (set = new Set(cellsInView(cell))));
  return set;
}

/** Every cell with a point possibly in view of `cell` (itself included), cached. */
export function cellsInView(cell: number): number[] {
  let list = neighbours.get(cell);
  if (list) return list;
  list = [];
  const cx = cell % ROW;
  const cy = Math.floor(cell / ROW);
  const span = Math.ceil((VIEW_REACH + AOI_CELL) / AOI_CELL);
  for (let y = Math.max(0, cy - span); y <= Math.min(ROWS - 1, cy + span); y++) {
    for (let x = Math.max(0, cx - span); x <= Math.min(ROW - 1, cx + span); x++) {
      const other = y * ROW + x;
      if (cellsMeet(cell, other)) list.push(other);
    }
  }
  neighbours.set(cell, list);
  return list;
}

/** Client fog: 1 up to AOI_FOG_START, fading to 0 at AOI_FOG_END. */
export function fogAt(distance: number): number {
  if (distance <= AOI_FOG_START) return 1;
  if (distance >= AOI_FOG_END) return 0;
  const t = (distance - AOI_FOG_START) / (AOI_FOG_END - AOI_FOG_START);
  return 1 - t * t * (3 - 2 * t); // smoothstep
}
