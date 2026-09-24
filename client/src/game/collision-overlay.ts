import { Sprite, Texture } from "pixi.js";
import type { CollisionMap } from "../../../shared/src/collision.ts";

const BLOCKED_COLOR = "rgba(255, 48, 48, 1)";

/**
 * Red tint over blocked cells. Backed by a canvas with one pixel per cell,
 * scaled up to map size, so single-cell edits are cheap.
 */
export class CollisionOverlay {
  readonly sprite: Sprite;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: Texture;
  private dirty = false;

  constructor(map: CollisionMap) {
    const canvas = document.createElement("canvas");
    canvas.width = map.cols;
    canvas.height = map.rows;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.fillStyle = BLOCKED_COLOR;
    for (let y = 0; y < map.rows; y++) {
      for (let x = 0; x < map.cols; x++) {
        if (!map.isCellWalkable(x, y)) this.ctx.fillRect(x, y, 1, 1);
      }
    }
    this.texture = Texture.from(canvas);
    this.sprite = new Sprite(this.texture);
    this.sprite.scale.set(map.cellSize);
    this.sprite.alpha = 0.4;
  }

  setCell(cx: number, cy: number, walkable: boolean): void {
    if (walkable) this.ctx.clearRect(cx, cy, 1, 1);
    else this.ctx.fillRect(cx, cy, 1, 1);
    this.dirty = true;
  }

  /** Upload pending edits to the GPU; call once per frame. */
  flush(): void {
    if (!this.dirty) return;
    this.texture.source.update();
    this.dirty = false;
  }
}
