import { COLLISION_CELL_SIZE, COLLISION_ROWS } from "./map/collision.ts";

const rows = COLLISION_ROWS.trim().split("\n");
const cols = rows[0].length;
const grid = new Uint8Array(cols * rows.length);
rows.forEach((row, y) => {
  for (let x = 0; x < cols; x++) grid[y * cols + x] = row[x] === "." ? 1 : 0;
});

export const collisionGrid = { cellSize: COLLISION_CELL_SIZE, cols, rows: rows.length, walkable: grid };

/** Half extents of the collision box around a character's feet. */
const FOOT_HALF_WIDTH = 5;
const FOOT_HALF_HEIGHT = 3;

function isCellWalkable(px: number, py: number): boolean {
  const cx = Math.floor(px / COLLISION_CELL_SIZE);
  const cy = Math.floor(py / COLLISION_CELL_SIZE);
  if (cx < 0 || cy < 0 || cx >= cols || cy >= rows.length) return false;
  return grid[cy * cols + cx] === 1;
}

/** True when a character whose feet are at (x, y) fits on walkable ground. */
export function canStandAt(x: number, y: number): boolean {
  return (
    isCellWalkable(x - FOOT_HALF_WIDTH, y - FOOT_HALF_HEIGHT) &&
    isCellWalkable(x + FOOT_HALF_WIDTH, y - FOOT_HALF_HEIGHT) &&
    isCellWalkable(x - FOOT_HALF_WIDTH, y + FOOT_HALF_HEIGHT) &&
    isCellWalkable(x + FOOT_HALF_WIDTH, y + FOOT_HALF_HEIGHT)
  );
}

/**
 * Move by (dx, dy), resolving each axis separately so characters slide
 * along walls instead of sticking to them.
 */
export function moveWithCollision(x: number, y: number, dx: number, dy: number): { x: number; y: number } {
  if (dx !== 0 && canStandAt(x + dx, y)) x += dx;
  if (dy !== 0 && canStandAt(x, y + dy)) y += dy;
  return { x, y };
}
