/** Half extents of the collision box around a character's feet. */
const FOOT_HALF_WIDTH = 5;
const FOOT_HALF_HEIGHT = 3;

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

  private isPointWalkable(px: number, py: number): boolean {
    return this.isCellWalkable(Math.floor(px / this.cellSize), Math.floor(py / this.cellSize));
  }

  /** True when a character whose feet are at (x, y) fits on walkable ground. */
  canStandAt(x: number, y: number): boolean {
    return (
      this.isPointWalkable(x - FOOT_HALF_WIDTH, y - FOOT_HALF_HEIGHT) &&
      this.isPointWalkable(x + FOOT_HALF_WIDTH, y - FOOT_HALF_HEIGHT) &&
      this.isPointWalkable(x - FOOT_HALF_WIDTH, y + FOOT_HALF_HEIGHT) &&
      this.isPointWalkable(x + FOOT_HALF_WIDTH, y + FOOT_HALF_HEIGHT)
    );
  }

  /**
   * Move by (dx, dy), resolving each axis separately so characters slide
   * along walls instead of sticking to them.
   */
  moveWithCollision(x: number, y: number, dx: number, dy: number): { x: number; y: number } {
    if (dx !== 0 && this.canStandAt(x + dx, y)) x += dx;
    if (dy !== 0 && this.canStandAt(x, y + dy)) y += dy;
    return { x, y };
  }
}
