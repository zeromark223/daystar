import { Container, Sprite, Texture } from "pixi.js";
import { PALETTE, type BodyKind } from "../../../shared/src/appearance.ts";
import { paintPlanet } from "./textures.ts";

/**
 * What each kind of body looks like. A body is a "rig": canvas-painted parts
 * placed around (0, 0) in world pixels, plus a face on the kinds that have one.
 * The game turns the parts into sprites and animates them with transforms only
 * (cheap with thousands of players); the lobby paints the same parts at rest.
 */

/** Size of each kind in world pixels at zoom 1; `face` is the radius the face is drawn on. */
export const SIZES: Record<BodyKind, { core: number; glow: number; face: number | null }> = {
  star: { core: 7, glow: 170, face: null },
  planet: { core: 14, glow: 130, face: 14 },
  ringed: { core: 12, glow: 130, face: 12 },
  comet: { core: 8, glow: 120, face: 8 },
  moon: { core: 11, glow: 110, face: 11 },
  gas: { core: 17, glow: 140, face: 17 },
  hole: { core: 10, glow: 140, face: 10 },
  binary: { core: 8, glow: 150, face: null },
  pulsar: { core: 6, glow: 160, face: null },
  moonlet: { core: 12, glow: 130, face: 12 },
  ufo: { core: 8, glow: 120, face: 4.8 },
};

/** Parts are painted this much sharper than their world size, so they stay crisp when zoomed in. */
const SUPERSAMPLE = 4;
const TAIL_LENGTH = 60;
const FACE_INK = 0x1b1533;

// ------------------------------------------------------------------ colors

const channels = (c: number) => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
const pack = (r: number, g: number, b: number) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
/** amount > 0 lightens towards white, < 0 darkens towards black. */
const shade = (c: number, amount: number) =>
  pack(...(channels(c).map((v) => (amount >= 0 ? v + (255 - v) * amount : v * (1 + amount))) as [number, number, number]));
const mix = (a: number, b: number, t: number) => {
  const y = channels(b);
  return pack(...(channels(a).map((v, i) => v + (y[i] - v) * t) as [number, number, number]));
};
const rgba = (c: number, a = 1) => {
  const [r, g, b] = channels(c);
  return `rgba(${r},${g},${b},${a})`;
};

// ------------------------------------------------------------------ parts

/** A painted part: `w` x `h` world pixels, anchored at (ax, ay) (fractions of the size). */
interface Part {
  key: string;
  w: number;
  h: number;
  ax: number;
  ay: number;
  /** Paints with the origin at the anchor, in world pixels. */
  paint(ctx: CanvasRenderingContext2D): void;
}

const canvases = new Map<string, HTMLCanvasElement>();
const textures = new Map<string, Texture>();

function partCanvas(p: Part): HTMLCanvasElement {
  let canvas = canvases.get(p.key);
  if (canvas) return canvas;
  canvas = document.createElement("canvas");
  canvas.width = Math.ceil(p.w * SUPERSAMPLE);
  canvas.height = Math.ceil(p.h * SUPERSAMPLE);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
  ctx.translate(p.ax * p.w, p.ay * p.h);
  p.paint(ctx);
  canvases.set(p.key, canvas);
  return canvas;
}

function partTexture(p: Part): Texture {
  let texture = textures.get(p.key);
  if (!texture) {
    texture = Texture.from(partCanvas(p));
    textures.set(p.key, texture);
  }
  return texture;
}

const centered = (key: string, w: number, h: number, paint: Part["paint"]): Part => ({ key, w, h, ax: 0.5, ay: 0.5, paint });

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function sparkle(r: number, color: number): Part {
  const spike = r * 3.2;
  return centered(`sparkle:${r}:${color}`, spike * 2 + 1, spike * 2 + 1, (ctx) => {
    ctx.fillStyle = rgba(shade(color, 0.6), 0.9);
    for (const [a, b] of [[0, 1], [1, 0]]) {
      ctx.beginPath();
      ctx.moveTo(-spike * b, -spike * a);
      ctx.lineTo(r * 0.35 * a, r * 0.35 * b);
      ctx.lineTo(spike * b, spike * a);
      ctx.lineTo(-r * 0.35 * a, -r * 0.35 * b);
      ctx.fill();
    }
    ctx.fillStyle = rgba(shade(color, 0.45));
    disc(ctx, 0, 0, r);
    ctx.fillStyle = "#fff";
    disc(ctx, 0, 0, r * 0.55);
  });
}

function sphere(r: number, color: number): Part {
  return centered(`sphere:${r}:${color}`, r * 2 + 1, r * 2 + 1, (ctx) => paintPlanet(ctx, 0, 0, r, color));
}

/** Half of an ellipse: the back (upper) or front (lower) of a ring or disk. */
function ringHalf(key: string, rx: number, ry: number, front: boolean, strokes: [number, number, number][]): Part {
  const pad = Math.max(...strokes.map((s) => s[1])) / 2 + 1;
  return centered(`${key}:${front}`, rx * 2 + pad * 2, ry * 2 + pad * 2, (ctx) => {
    for (const [color, width, alpha] of strokes) {
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2);
      ctx.strokeStyle = rgba(color, alpha);
      ctx.lineWidth = width;
      ctx.stroke();
    }
  });
}

function moon(r: number, color: number): Part {
  const base = mix(color, 0xb9bdc9, 0.62);
  return centered(`moon:${r}:${color}`, r * 2 + 1, r * 2 + 1, (ctx) => {
    paintPlanet(ctx, 0, 0, r, base);
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();
    const craters = [[-0.45, -0.35, 0.22], [0.42, -0.5, 0.14], [0.5, 0.35, 0.2], [-0.2, 0.55, 0.12], [0.05, -0.05, 0.1]];
    for (const [x, y, s] of craters) {
      ctx.fillStyle = rgba(shade(base, -0.28), 0.75);
      disc(ctx, x * r, y * r, s * r);
      ctx.strokeStyle = rgba(shade(base, 0.35), 0.5);
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.arc(x * r + 0.4, y * r + 0.4, s * r, Math.PI * 0.1, Math.PI * 0.9);
      ctx.stroke();
    }
    ctx.restore();
  });
}

function gasGiant(r: number, color: number): Part {
  return centered(`gas:${r}:${color}`, r * 2 + 1, r * 2 + 1, (ctx) => {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = rgba(color);
    ctx.fillRect(-r, -r, r * 2, r * 2);
    for (let i = -6; i <= 6; i++) {
      const y = i * r * 0.27;
      const h = r * (i % 2 ? 0.16 : 0.1);
      ctx.fillStyle = rgba(shade(color, i % 2 ? -0.2 : 0.22), 0.9);
      ctx.beginPath();
      ctx.moveTo(-r, y);
      for (let x = -r; x <= r; x += 2) ctx.lineTo(x, y + Math.sin(x * 0.35 + i) * 0.9);
      ctx.lineTo(r, y + h);
      ctx.lineTo(-r, y + h);
      ctx.fill();
    }
    ctx.fillStyle = rgba(shade(color, -0.38), 0.85);
    ctx.beginPath();
    ctx.ellipse(r * 0.3, r * 0.42, r * 0.24, r * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // Lit from the top left, darker towards the limb.
    const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
    g.addColorStop(0, "rgba(255,255,255,0.22)");
    g.addColorStop(0.55, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = g;
    disc(ctx, 0, 0, r);
  });
}

function holeCore(r: number, color: number): Part {
  return centered(`hole:${r}:${color}`, r * 2.4, r * 2.4, (ctx) => {
    ctx.fillStyle = "#000";
    disc(ctx, 0, 0, r);
    ctx.strokeStyle = rgba(shade(color, 0.7), 0.95);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.06, 0, Math.PI * 2);
    ctx.stroke();
  });
}

function cometHead(r: number, color: number): Part {
  return centered(`comet:${r}:${color}`, r * 2 + 1, r * 2 + 1, (ctx) => {
    const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 0, 0, 0, r);
    g.addColorStop(0, "#fff");
    g.addColorStop(0.45, rgba(shade(color, 0.45)));
    g.addColorStop(1, rgba(shade(color, -0.1)));
    ctx.fillStyle = g;
    disc(ctx, 0, 0, r);
  });
}

/** The comet's tail, pointing right from its anchor; stretched along x to its current length. */
function cometTail(r: number, color: number): Part {
  return {
    key: `tail:${r}:${color}`,
    w: TAIL_LENGTH,
    h: r * 2 + 1,
    ax: 0,
    ay: 0.5,
    paint(ctx) {
      for (const [w, a, l] of [[1, 0.5, TAIL_LENGTH], [0.55, 0.75, TAIL_LENGTH * 0.7]]) {
        const g = ctx.createLinearGradient(0, 0, l, 0);
        g.addColorStop(0, rgba(shade(color, 0.45), a));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, -r * w);
        ctx.quadraticCurveTo(l * 0.5, -r * w * 0.6, l, 0);
        ctx.quadraticCurveTo(l * 0.5, r * w * 0.6, 0, r * w);
        ctx.fill();
      }
    },
  };
}

function pulsarBeams(color: number): Part {
  const len = 58;
  return centered(`beams:${color}`, len * 2, 10, (ctx) => {
    for (const s of [1, -1]) {
      const g = ctx.createLinearGradient(0, 0, s * len, 0);
      g.addColorStop(0, rgba(shade(color, 0.6), 0.85));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -1.6);
      ctx.lineTo(s * len, -5);
      ctx.lineTo(s * len, 5);
      ctx.lineTo(0, 1.6);
      ctx.fill();
    }
  });
}

function pulsarCore(color: number): Part {
  return centered(`pulsar:${color}`, 16, 16, (ctx) => {
    ctx.fillStyle = rgba(shade(color, 0.3), 0.9);
    disc(ctx, 0, 0, 7.5);
    ctx.fillStyle = "#fff";
    disc(ctx, 0, 0, 4.6);
  });
}

function saucer(color: number): Part {
  return centered(`saucer:${color}`, 36, 13, (ctx) => {
    const g = ctx.createLinearGradient(0, -4, 0, 5);
    g.addColorStop(0, "#e9ecf7");
    g.addColorStop(0.5, "#9aa1b8");
    g.addColorStop(1, "#4b5168");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, 17, 5.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgba(shade(color, -0.1));
    ctx.fillRect(-15, -0.6, 30, 1.4);
    ctx.fillStyle = rgba(shade(color, -0.3));
    for (let i = 0; i < 5; i++) disc(ctx, -11 + i * 5.5, 2.6, 1.1);
  });
}

function dome(color: number, shine: boolean): Part {
  return {
    key: `dome:${color}:${shine}`,
    w: 18,
    h: 9,
    ax: 0.5,
    ay: 1,
    paint(ctx) {
      if (shine) {
        ctx.strokeStyle = "rgba(255,255,255,0.45)";
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(0, 0, 8, Math.PI * 1.1, Math.PI * 1.45);
        ctx.stroke();
      } else {
        ctx.fillStyle = rgba(shade(color, 0.5), 0.22);
        ctx.beginPath();
        ctx.arc(0, 0, 8, Math.PI, 0);
        ctx.fill();
      }
    },
  };
}

function lamp(color: number): Part {
  return centered(`lamp:${color}`, 3, 3, (ctx) => {
    ctx.fillStyle = rgba(shade(color, 0.7));
    disc(ctx, 0, 0, 1.2);
  });
}

// ------------------------------------------------------------------ face parts

function eye(r: number, glowColor: number | null): Part {
  const er = r * 0.16;
  return centered(`eye:${r}:${glowColor}`, er * 2, er * 2 + 0.5, (ctx) => {
    ctx.fillStyle = rgba(glowColor === null ? FACE_INK : shade(glowColor, 0.65));
    ctx.beginPath();
    ctx.ellipse(0, 0, er * 0.82, er, 0, 0, Math.PI * 2);
    ctx.fill();
    if (glowColor === null) {
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      disc(ctx, -er * 0.28, -er * 0.32, er * 0.3);
    }
  });
}

function blush(r: number): Part {
  return centered(`blush:${r}`, r * 0.34, r * 0.2, (ctx) => {
    ctx.fillStyle = "rgba(255,120,150,0.35)";
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.16, r * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
  });
}

function smile(r: number, glowColor: number | null): Part {
  const w = Math.max(0.6, r * 0.075);
  return centered(`smile:${r}:${glowColor}`, r * 0.4, r * 0.4, (ctx) => {
    ctx.strokeStyle = rgba(glowColor === null ? FACE_INK : shade(glowColor, 0.65));
    ctx.lineWidth = w;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.14, Math.PI * 0.2, Math.PI * 0.8);
    ctx.stroke();
  });
}

/** An open mouth at full volume; scaled down vertically for quieter sounds. */
function mouth(r: number, glowColor: number | null): Part {
  return centered(`mouth:${r}:${glowColor}`, r * 0.26, r * 0.42, (ctx) => {
    ctx.fillStyle = rgba(glowColor === null ? FACE_INK : shade(glowColor, 0.65));
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.12, r * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
  });
}

// ------------------------------------------------------------------ rigs

interface PartNode {
  name?: string;
  part: Part;
  x: number;
  y: number;
  /** Additive blending, for light (disks, beams, tails). */
  add?: boolean;
}
/** Where the face goes in the drawing order; black holes get glowing eyes. */
interface FaceNode {
  face: true;
  x: number;
  y: number;
  r: number;
  glow: number | null;
}
type Node = PartNode | FaceNode;

function rig(kind: BodyKind, colorIndex: number): Node[] {
  const color = PALETTE[colorIndex].color;
  const r = SIZES[kind].core;
  const face = (x = 0, y = 0, fr = SIZES[kind].face ?? r, glow: number | null = null): FaceNode => ({ face: true, x, y, r: fr, glow });
  switch (kind) {
    case "star":
      return [{ part: sparkle(r, color), x: 0, y: 0 }];
    case "planet":
      return [{ part: sphere(r, color), x: 0, y: 0 }, face()];
    case "ringed": {
      const strokes: [number, number, number][] = [[shade(color, 0.35), 2.2, 0.85]];
      return [
        { part: ringHalf(`ring:${r}:${color}`, r * 2.3, r * 0.75, false, strokes), x: 0, y: 0 },
        { part: sphere(r, color), x: 0, y: 0 },
        face(),
        { part: ringHalf(`ring:${r}:${color}`, r * 2.3, r * 0.75, true, strokes), x: 0, y: 0 },
      ];
    }
    case "comet":
      return [{ name: "tail", part: cometTail(r, color), x: 0, y: 0, add: true }, { part: cometHead(r, color), x: 0, y: 0 }, face()];
    case "moon":
      return [{ part: moon(r, color), x: 0, y: 0 }, face()];
    case "gas":
      return [{ part: gasGiant(r, color), x: 0, y: 0 }, face()];
    case "hole": {
      const strokes: [number, number, number][] = [
        [shade(color, 0.15), r * 0.9, 0.45],
        [shade(color, 0.6), 1.4, 0.9],
      ];
      return [
        { part: ringHalf(`disk:${r}:${color}`, r * 2.6, r * 0.8, false, strokes), x: 0, y: 0, add: true },
        { part: holeCore(r, color), x: 0, y: 0 },
        face(0, 0, r, color),
        { part: ringHalf(`disk:${r}:${color}`, r * 2.6, r * 0.8, true, strokes), x: 0, y: 0, add: true },
      ];
    }
    case "binary": {
      const other = PALETTE[(colorIndex + 3) % PALETTE.length].color;
      return [
        { name: "a", part: sparkle(4.2, color), x: 9, y: 0 },
        { name: "b", part: sparkle(4.2, other), x: -9, y: 0 },
      ];
    }
    case "pulsar":
      return [{ name: "beams", part: pulsarBeams(color), x: 0, y: 0, add: true }, { part: pulsarCore(color), x: 0, y: 0 }];
    case "moonlet":
      return [
        { part: sphere(r, color), x: 0, y: 0 },
        face(),
        { name: "moon", part: sphere(3.6, mix(color, 0xc9ccd6, 0.7)), x: 23, y: -2 },
      ];
    case "ufo":
      return [
        { part: dome(color, false), x: 0, y: -3 },
        { part: sphere(4.8, color), x: 0, y: -5 },
        face(0, -5),
        { part: dome(color, true), x: 0, y: -3 },
        { part: saucer(color), x: 0, y: 0 },
        { name: "lamp", part: lamp(color), x: -11, y: 2.6 },
      ];
  }
}

/** Face parts and their resting places, relative to the face center. */
function faceParts(r: number, glow: number | null) {
  const er = r * 0.16;
  return {
    blush: glow === null ? [-1, 1].map((s) => ({ part: blush(r), x: s * r * 0.58, y: r * 0.2 })) : [],
    eyes: [-1, 1].map((s) => ({ part: eye(r, glow), x: s * r * 0.36, y: -r * 0.06, er })),
    smile: { part: smile(r, glow), x: 0, y: r * 0.22 },
    mouth: { part: mouth(r, glow), x: 0, y: r * 0.3 },
  };
}

function sprite(node: { part: Part; x: number; y: number; add?: boolean }): Sprite {
  const { part } = node;
  const s = new Sprite({ texture: partTexture(part), anchor: { x: part.ax, y: part.ay } });
  s.width = Math.ceil(part.w * SUPERSAMPLE) / SUPERSAMPLE;
  s.height = Math.ceil(part.h * SUPERSAMPLE) / SUPERSAMPLE;
  s.position.set(node.x, node.y);
  if (node.add) s.blendMode = "add";
  return s;
}

// ------------------------------------------------------------------ in the game

/** Motion of the player this frame, in world pixels per second. */
export interface Motion {
  vx: number;
  vy: number;
  moving: boolean;
}

/** A body in the game: its sprites, and the small animations that bring it to life. */
export class BodyView {
  readonly view = new Container();
  private readonly named = new Map<string, Sprite>();
  private face: Container | null = null;
  private faceR = 0;
  private eyes: Sprite[] = [];
  private eyeScaleY = 1;
  private smile: Sprite | null = null;
  private mouth: Sprite | null = null;
  private mouthScaleY = 1;
  private nextBlink = performance.now() + 1000 + Math.random() * 3000;
  private lookX = 0;
  private lookY = 0;
  private tailAngle = -Math.PI / 5;
  private tailLength = 26;
  private moonFront = true;
  /** Each body starts its idle animations at a different phase. */
  private readonly phase = Math.random() * 1000;

  private readonly kind: BodyKind;

  constructor(kind: BodyKind, colorIndex: number) {
    this.kind = kind;
    for (const node of rig(kind, colorIndex)) {
      if ("face" in node) {
        this.view.addChild(this.buildFace(node));
        continue;
      }
      const s = sprite(node);
      if (node.name) this.named.set(node.name, s);
      this.view.addChild(s);
    }
  }

  private buildFace(node: FaceNode): Container {
    const face = new Container();
    face.position.set(node.x, node.y);
    const parts = faceParts(node.r, node.glow);
    for (const b of parts.blush) face.addChild(sprite(b));
    this.eyes = parts.eyes.map((e) => face.addChild(sprite(e)));
    this.eyeScaleY = this.eyes[0].scale.y;
    this.smile = face.addChild(sprite(parts.smile));
    this.mouth = face.addChild(sprite(parts.mouth));
    this.mouthScaleY = this.mouth.scale.y;
    this.mouth.visible = false;
    this.face = face;
    this.faceR = node.r;
    return face;
  }

  /** Call every frame while the body is visible. `voice` is 0..1. */
  update(now: number, motion: Motion, voice: number): void {
    const t = (now + this.phase) / 1000;
    const speed = Math.hypot(motion.vx, motion.vy);
    switch (this.kind) {
      case "star":
        this.view.rotation = now * 0.0006;
        break;
      case "comet":
        this.updateTail(motion, speed);
        break;
      case "binary": {
        const a = t * 2.4;
        for (const [name, angle] of [["a", a], ["b", a + Math.PI]] as const) {
          const s = this.named.get(name)!;
          s.position.set(Math.cos(angle) * 9, Math.sin(angle) * 3.5);
          const k = 0.85 + 0.15 * Math.sin(angle);
          s.scale.set(this.baseScale(s) * k);
        }
        // The nearer star is drawn on top.
        const [sa, sb] = [this.named.get("a")!, this.named.get("b")!];
        if ((sa.y > sb.y) !== (this.view.getChildIndex(sa) > this.view.getChildIndex(sb))) this.view.swapChildren(sa, sb);
        break;
      }
      case "pulsar":
        this.named.get("beams")!.rotation = t * 3.6;
        break;
      case "moonlet": {
        const a = t * 1.3;
        const m = this.named.get("moon")!;
        m.position.set(Math.cos(a) * 23, Math.sin(a) * 8 - 2);
        const front = Math.sin(a) >= 0;
        if (front !== this.moonFront) {
          this.moonFront = front;
          this.view.setChildIndex(m, front ? this.view.children.length - 1 : 0);
        }
        break;
      }
      case "ufo":
        this.view.pivot.y = -Math.sin(t * 2.2) * 1.5;
        this.named.get("lamp")!.x = -11 + (Math.floor(t * 6) % 5) * 5.5;
        break;
    }
    if (this.face) this.updateFace(now, motion, speed, voice);
  }

  private readonly baseScales = new Map<Sprite, number>();
  private baseScale(s: Sprite): number {
    let k = this.baseScales.get(s);
    if (k === undefined) {
      k = s.scale.x;
      this.baseScales.set(s, k);
    }
    return k;
  }

  private updateTail(motion: Motion, speed: number): void {
    const tail = this.named.get("tail")!;
    // Behind the motion while walking; drifting up and to the right at rest.
    const target = motion.moving && speed > 20 ? Math.atan2(-motion.vy, -motion.vx) : -Math.PI / 5;
    let d = target - this.tailAngle;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.tailAngle += d * 0.15;
    const length = motion.moving ? 26 + 40 * Math.min(1, speed / 400) : 26;
    this.tailLength += (length - this.tailLength) * 0.1;
    tail.rotation = this.tailAngle;
    tail.scale.x = (this.baseScale(tail) * this.tailLength) / TAIL_LENGTH;
  }

  private updateFace(now: number, motion: Motion, speed: number, voice: number): void {
    const r = this.faceR;
    // Look where we are going, or let the eyes wander a little.
    const tx = speed > 20 ? motion.vx / speed : Math.sin((now + this.phase) / 2000) * 0.4;
    const ty = speed > 20 ? motion.vy / speed : 0;
    this.lookX += (tx - this.lookX) * 0.12;
    this.lookY += (ty - this.lookY) * 0.12;
    const face = this.face!;
    face.pivot.set(-this.lookX * r * 0.1, -this.lookY * r * 0.06);
    let blink = 0;
    if (now > this.nextBlink + 160) this.nextBlink = now + 2500 + Math.random() * 3500;
    else if (now > this.nextBlink) blink = 1 - Math.abs((now - this.nextBlink) / 80 - 1);
    for (const e of this.eyes) e.scale.y = this.eyeScaleY * Math.max(0.08, 1 - blink);
    const open = voice > 0.08;
    this.smile!.visible = !open;
    this.mouth!.visible = open;
    if (open) this.mouth!.scale.y = this.mouthScaleY * (0.2 + 0.8 * Math.min(1, voice));
  }
}

// ------------------------------------------------------------------ in the lobby

/** Paint a body at rest, centered on (cx, cy) and `scale` times its world size. */
export function paintBody(ctx: CanvasRenderingContext2D, kind: BodyKind, colorIndex: number, cx: number, cy: number, scale: number): void {
  const draw = (node: { part: Part; x: number; y: number; add?: boolean }, ox = 0, oy = 0) => {
    const { part } = node;
    ctx.save();
    if (node.add) ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(
      partCanvas(part),
      cx + (ox + node.x - part.ax * part.w) * scale,
      cy + (oy + node.y - part.ay * part.h) * scale,
      part.w * scale,
      part.h * scale,
    );
    ctx.restore();
  };
  for (const node of rig(kind, colorIndex)) {
    if (!("face" in node)) {
      if (node.name === "tail") {
        // At rest the tail drifts up and to the right, shorter than full length.
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-Math.PI / 5);
        ctx.globalCompositeOperation = "lighter";
        const p = node.part;
        ctx.drawImage(partCanvas(p), 0, -p.ay * p.h * scale, p.w * scale * 0.55, p.h * scale);
        ctx.restore();
      } else draw(node);
      continue;
    }
    const parts = faceParts(node.r, node.glow);
    for (const b of parts.blush) draw(b, node.x, node.y);
    for (const e of parts.eyes) draw(e, node.x, node.y);
    draw(parts.smile, node.x, node.y);
  }
}
