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

function shade(color: number, amount: number): string {
  // amount > 0 lightens towards white, < 0 darkens towards black.
  const channel = (c: number) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  const r = channel((color >> 16) & 0xff);
  const g = channel((color >> 8) & 0xff);
  const b = channel(color & 0xff);
  return `rgb(${r},${g},${b})`;
}

/**
 * Paint a lit sphere of radius `r` centered at (cx, cy): light from the top
 * left, fading to a darker limb. The shading never leaves the disc.
 */
export function paintPlanet(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: number): void {
  const g = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.45, r * 0.05, cx - r * 0.1, cy - r * 0.1, r * 1.15);
  g.addColorStop(0, shade(color, 0.6));
  g.addColorStop(0.35, shade(color, 0.05));
  g.addColorStop(0.8, shade(color, -0.35));
  g.addColorStop(1, shade(color, -0.6));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

const planets = new Map<string, Texture>();
/** Sharper than the on-screen size so planets stay crisp when zoomed in. */
const PLANET_SUPERSAMPLE = 4;

/** A shaded sphere texture of world radius `radius`; draw it at width = 2 * radius. */
export function planetTexture(color: number, radius: number): Texture {
  const key = `${color}:${radius}`;
  let texture = planets.get(key);
  if (texture) return texture;
  const r = radius * PLANET_SUPERSAMPLE;
  const size = Math.ceil(r * 2) + 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  paintPlanet(canvas.getContext("2d")!, size / 2, size / 2, r, color);
  texture = Texture.from(canvas);
  planets.set(key, texture);
  return texture;
}

const emojis = new Map<string, Texture>();

/** An emoji drawn once with the system's emoji font; draw it at about 28 px. */
export function emojiTexture(emoji: string): Texture {
  let texture = emojis.get(emoji);
  if (texture) return texture;
  const size = 96;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${size * 0.78}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, size / 2, size / 2 + size * 0.04);
  texture = Texture.from(canvas);
  emojis.set(emoji, texture);
  return texture;
}
