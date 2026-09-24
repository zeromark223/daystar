/** Radius of a character's circular collision body, in map pixels. */
export const BODY_RADIUS = 4;

/**
 * When a move is blocked on both axes, try it rotated by these angles (each way,
 * smallest first) so characters glide along diagonal walls and round corners.
 */
const GLIDE_ROTATIONS = [30, 45, 60, 75].map((deg) => {
  const rad = (deg * Math.PI) / 180;
  return { cos: Math.cos(rad), sin: Math.sin(rad) };
});

/**
 * Walkability grid for the map.
 *
 * Text format (client/public/assets/collision.txt): a "cell=<px>" header line,
 * then one line per row where '.' is walkable and '#' is blocked.
 */
export class CollisionMap {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  private readonly cells: Uint8Array;

  constructor(cellSize: number, cols: number, rows: number, cells = new Uint8Array(cols * rows)) {
    this.cellSize = cellSize;
    this.cols = cols;
    this.rows = rows;
    this.cells = cells;
  }

  static parse(text: string): CollisionMap {
    const lines = text.trim().split(/\r?\n/);
    const header = lines.shift()?.match(/^cell=(\d+)$/);
    if (!header) throw new Error("Collision map: missing cell=<px> header");
    const cols = lines[0]?.length ?? 0;
    if (cols === 0) throw new Error("Collision map: no rows");

    const map = new CollisionMap(Number(header[1]), cols, lines.length);
    lines.forEach((line, y) => {
      if (line.length !== cols || /[^.#]/.test(line)) throw new Error(`Collision map: bad row ${y}`);
      for (let x = 0; x < cols; x++) map.cells[y * cols + x] = line[x] === "." ? 1 : 0;
    });
    return map;
  }

  serialize(): string {
    const lines = [`cell=${this.cellSize}`];
    for (let y = 0; y < this.rows; y++) {
      let row = "";
      for (let x = 0; x < this.cols; x++) row += this.cells[y * this.cols + x] ? "." : "#";
      lines.push(row);
    }
    return lines.join("\n") + "\n";
  }

  /** Overwrite this map in place so existing references see the new data. */
  copyFrom(other: CollisionMap): void {
    if (other.cellSize !== this.cellSize || other.cols !== this.cols || other.rows !== this.rows) {
      throw new Error("Collision map: dimensions do not match");
    }
    this.cells.set(other.cells);
  }

  isCellWalkable(cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return false;
    return this.cells[cy * this.cols + cx] === 1;
  }

  /** Returns true when the cell actually changed. */
  setCell(cx: number, cy: number, walkable: boolean): boolean {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return false;
    const i = cy * this.cols + cx;
    const value = walkable ? 1 : 0;
    if (this.cells[i] === value) return false;
    this.cells[i] = value;
    return true;
  }

  /**
   * True when a character whose feet are at (x, y) fits on walkable ground.
   * The body is a circle of BODY_RADIUS centered `offsetY` pixels above the feet.
   */
  canStandAt(x: number, y: number, offsetY = 0): boolean {
    const cy = y - offsetY;
    const size = this.cellSize;
    const minX = Math.floor((x - BODY_RADIUS) / size);
    const maxX = Math.floor((x + BODY_RADIUS) / size);
    const minY = Math.floor((cy - BODY_RADIUS) / size);
    const maxY = Math.floor((cy + BODY_RADIUS) / size);
    for (let gy = minY; gy <= maxY; gy++) {
      for (let gx = minX; gx <= maxX; gx++) {
        if (this.isCellWalkable(gx, gy)) continue;
        // Distance from the circle center to the nearest point of this blocked cell.
        const nx = Math.max(gx * size, Math.min(x, (gx + 1) * size));
        const ny = Math.max(gy * size, Math.min(cy, (gy + 1) * size));
        if ((x - nx) ** 2 + (cy - ny) ** 2 < BODY_RADIUS * BODY_RADIUS) return false;
      }
    }
    return true;
  }

  /**
   * Move by (dx, dy) without entering blocked cells. Tries, in order: the full
   * move, sliding along each axis, then the move rotated by GLIDE_ROTATIONS so
   * characters glide along diagonal walls (e.g. stair rails) instead of snagging.
   */
  moveWithCollision(x: number, y: number, dx: number, dy: number, offsetY = 0): { x: number; y: number } {
    if (dx === 0 && dy === 0) return { x, y };
    if (this.canStandAt(x + dx, y + dy, offsetY)) return { x: x + dx, y: y + dy };

    let nx = x;
    let ny = y;
    if (dx !== 0 && this.canStandAt(x + dx, y, offsetY)) nx += dx;
    if (dy !== 0 && this.canStandAt(nx, y + dy, offsetY)) ny += dy;
    if (nx !== x || ny !== y) return { x: nx, y: ny };

    for (const { cos, sin } of GLIDE_ROTATIONS) {
      for (const sign of [1, -1]) {
        const rx = dx * cos - dy * sin * sign;
        const ry = dx * sin * sign + dy * cos;
        if (this.canStandAt(x + rx, y + ry, offsetY)) return { x: x + rx, y: y + ry };
      }
    }
    return { x, y };
  }
}
