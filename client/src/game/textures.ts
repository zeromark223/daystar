import { Texture } from "pixi.js";

/**
 * Textures generated at startup with a 2D canvas, so the game needs no image
 * files. Each is created once and shared.
 */

let glow: Texture | null = null;

/** A soft white radial glow; tint it and scale it for halos, the sun and nebulae. */
export function glowTexture(): Texture {
  if (glow) return glow;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.55)");
  g.addColorStop(0.45, "rgba(255,255,255,0.16)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glow = Texture.from(canvas);
  return glow;
}

/** Seeded random so the sky looks the same on every visit. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A tileable square of scattered stars for one parallax layer. */
export function starTileTexture(opts: { size: number; count: number; maxRadius: number; seed: number }): Texture {
  const { size, count, maxRadius, seed } = opts;
  const random = seededRandom(seed);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const tints = ["255,255,255", "200,220,255", "255,236,210", "210,200,255"];
  for (let i = 0; i < count; i++) {
    const x = random() * size;
    const y = random() * size;
    const r = 0.4 + random() ** 3 * maxRadius;
    const a = 0.25 + random() * 0.75;
    ctx.fillStyle = `rgba(${tints[Math.floor(random() * tints.length)]},${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return Texture.from(canvas);
}
