import { Container, Graphics } from "pixi.js";
import { FADE_START, SUN_RADIUS, WORLD_CENTER, WORLD_RADIUS } from "../../../shared/src/constants.ts";
import { brightnessAt } from "../../../shared/src/space.ts";

const RADIUS = 78;
const MARGIN = 16;
const REDRAW_MS = 100;

export interface MinimapDot {
  x: number;
  y: number;
  color: number;
  self: boolean;
}

/** A small round map in the bottom-right corner: sun, edge, players and your view. */
export class Minimap {
  readonly view = new Container();
  private readonly frame = new Graphics();
  private readonly dots = new Graphics();
  private lastDraw = 0;

  constructor() {
    const k = RADIUS / WORLD_RADIUS;
    this.frame
      .circle(0, 0, RADIUS + 6)
      .fill({ color: 0x070a1a, alpha: 0.72 })
      .stroke({ color: 0x7a8cff, width: 1, alpha: 0.45 })
      .circle(0, 0, RADIUS * FADE_START)
      .stroke({ color: 0x7a8cff, width: 1, alpha: 0.18 })
      .circle(0, 0, Math.max(3, SUN_RADIUS * k))
      .fill({ color: 0xffc766 });
    this.view.addChild(this.frame, this.dots);
  }

  /** Keep the map in the corner of a `width` x `height` screen, above the hint line. */
  layout(width: number, height: number): void {
    this.view.position.set(width - RADIUS - MARGIN - 6, height - RADIUS - MARGIN - 34);
  }

  update(now: number, dots: Iterable<MinimapDot>, viewport: { x: number; y: number; w: number; h: number }): void {
    if (now - this.lastDraw < REDRAW_MS) return;
    this.lastDraw = now;
    const k = RADIUS / WORLD_RADIUS;
    const g = this.dots.clear();
    // The part of the world on screen, clipped to the map.
    const vx = (viewport.x - WORLD_CENTER.x) * k;
    const vy = (viewport.y - WORLD_CENTER.y) * k;
    g.rect(vx, vy, Math.max(2, viewport.w * k), Math.max(2, viewport.h * k)).stroke({
      color: 0xffffff,
      width: 1,
      alpha: 0.35,
    });
    let self: MinimapDot | null = null;
    for (const d of dots) {
      if (d.self) {
        self = d;
        continue;
      }
      const b = brightnessAt(d.x, d.y);
      if (b <= 0) continue; // faded out at the edge: hidden here too
      g.circle((d.x - WORLD_CENTER.x) * k, (d.y - WORLD_CENTER.y) * k, 1.8).fill({ color: d.color, alpha: b });
    }
    if (self) {
      g.circle((self.x - WORLD_CENTER.x) * k, (self.y - WORLD_CENTER.y) * k, 3.2)
        .fill({ color: self.color })
        .stroke({ color: 0xffffff, width: 1.2 });
    }
  }
}
