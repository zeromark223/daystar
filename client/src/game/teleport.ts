import { Container, Sprite, Texture } from "pixi.js";
import { glowTexture } from "./textures.ts";

/**
 * The flash where a player vanishes from its seat or appears at home on a
 * release: a quick glow and a ring opening out, in the player's color. A pool
 * of sprites sharing two textures (they batch into a draw call or two), at most
 * MAX_TELEPORTS at once, and only for players on screen: a release of thousands
 * costs about the same as one of a few dozen.
 */

const MAX_TELEPORTS = 200;
const LIFE_MS = 450;
/** World sizes at zoom 1 (scaled up when zoomed out, like the bodies). */
const FLASH_SIZE = 80;
const RING_SIZE = 110;
const MIN_SCREEN_SCALE = 0.55;

let ringTex: Texture | null = null;

/** A soft white ring on transparent, for tinting. */
function ringTexture(): Texture {
  if (ringTex) return ringTex;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
      const a = Math.exp(-(((r - 0.78) / 0.09) ** 2));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * a);
    }
  }
  ctx.putImageData(img, 0, 0);
  ringTex = Texture.from(canvas);
  return ringTex;
}

interface Burst {
  flash: Sprite;
  ring: Sprite;
  born: number;
  /** "out": a sharper flash as it vanishes; "in": a softer one as it appears. */
  out: boolean;
}

export class TeleportFx {
  readonly view = new Container();
  private readonly free: Burst[] = [];
  private readonly live: Burst[] = [];

  constructor() {
    this.view.blendMode = "add";
  }

  get count(): number {
    return this.live.length;
  }

  /** A burst at (x, y), unless MAX_TELEPORTS are already playing. */
  spawn(x: number, y: number, color: number, out: boolean, now: number): void {
    if (this.live.length >= MAX_TELEPORTS) return;
    let b = this.free.pop();
    if (!b) {
      const flash = new Sprite({ texture: glowTexture(), anchor: 0.5 });
      const ring = new Sprite({ texture: ringTexture(), anchor: 0.5 });
      flash.blendMode = ring.blendMode = "add";
      this.view.addChild(flash, ring);
      b = { flash, ring, born: 0, out };
    }
    b.born = now;
    b.out = out;
    b.flash.position.set(x, y);
    b.ring.position.set(x, y);
    b.flash.tint = out ? 0xffffff : color;
    b.ring.tint = color;
    b.flash.visible = b.ring.visible = true;
    this.live.push(b);
  }

  update(now: number, zoom: number): void {
    const scale = Math.max(1, MIN_SCREEN_SCALE / zoom);
    for (let i = this.live.length - 1; i >= 0; i--) {
      const b = this.live[i];
      const k = (now - b.born) / LIFE_MS;
      if (k >= 1) {
        b.flash.visible = b.ring.visible = false;
        this.live.splice(i, 1);
        this.free.push(b);
        continue;
      }
      // The flash pops up fast and dies away; the ring opens out and fades.
      const pop = b.out ? Math.sin(Math.min(1, k * 2.2) * Math.PI) : Math.sin(Math.min(1, k * 1.6) * Math.PI);
      b.flash.width = b.flash.height = FLASH_SIZE * scale * (0.6 + 0.8 * pop);
      b.flash.alpha = pop;
      const open = 1 - (1 - k) ** 3;
      b.ring.width = b.ring.height = RING_SIZE * scale * (0.25 + 1.1 * open);
      b.ring.alpha = 0.9 * (1 - k);
    }
  }

  clear(): void {
    for (const b of this.live) {
      b.flash.visible = b.ring.visible = false;
      this.free.push(b);
    }
    this.live.length = 0;
  }
}
