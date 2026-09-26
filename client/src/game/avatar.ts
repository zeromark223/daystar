import { Container, Graphics, Sprite, Text } from "pixi.js";
import { appearanceOf, type AppearanceId, type BodyKind } from "../../../shared/src/appearance.ts";
import { TICK_RATE } from "../../../shared/src/constants.ts";
import type { Direction } from "../../../shared/src/direction.ts";
import type { PlayerInfo } from "../../../shared/src/protocol.ts";
import { brightnessAt } from "../../../shared/src/space.ts";
import { glowTexture, planetTexture } from "./textures.ts";

const BUBBLE_MS = 6000;
const BUBBLE_MAX_WIDTH = 220;
/** A gap longer than this between samples means the player was idle. */
const SAMPLE_GAP_MS = 150;
/** Remote players are drawn this far in the past so there are two samples to blend. */
export const INTERPOLATION_DELAY_MS = 100;
/** Trail: positions kept while moving, and how often one is recorded. */
const TRAIL_POINTS = 14;
const TRAIL_EVERY_MS = 45;
/** Bodies never shrink below this share of their size when the camera zooms out. */
const MIN_SCREEN_SCALE = 0.55;

/** Size of each kind of body, in world pixels at zoom 1. */
const SIZES: Record<BodyKind, { core: number; glow: number }> = {
  star: { core: 7, glow: 170 },
  planet: { core: 14, glow: 130 },
  ringed: { core: 12, glow: 130 },
};

interface Sample {
  t: number;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
}

function lighten(color: number, amount: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

/** Half of an ellipse (the back or front of a planet's ring). */
function ringHalf(g: Graphics, rx: number, ry: number, front: boolean, color: number): void {
  const steps = 24;
  const from = front ? 0 : Math.PI;
  g.moveTo(Math.cos(from) * rx, Math.sin(from) * ry);
  for (let i = 1; i <= steps; i++) {
    const a = from + (i / steps) * Math.PI;
    g.lineTo(Math.cos(a) * rx, Math.sin(a) * ry);
  }
  g.stroke({ color, width: 2.2, alpha: 0.85 });
}

/** The body itself (without the glow), drawn around (0, 0). */
function drawBody(kind: BodyKind, color: number): Container {
  const r = SIZES[kind].core;
  if (kind === "star") {
    // A bright core with a four-pointed sparkle.
    const g = new Graphics();
    const spike = r * 3.2;
    g.poly([0, -spike, r * 0.35, 0, 0, spike, -r * 0.35, 0]).fill({ color: lighten(color, 0.6), alpha: 0.9 });
    g.poly([-spike, 0, 0, r * 0.35, spike, 0, 0, -r * 0.35]).fill({ color: lighten(color, 0.6), alpha: 0.9 });
    g.circle(0, 0, r).fill({ color: lighten(color, 0.45) });
    g.circle(0, 0, r * 0.55).fill({ color: 0xffffff });
    return g;
  }
  // Planets: a shaded sphere, with a ring passing behind and in front of it.
  const body = new Container();
  const ringColor = lighten(color, 0.35);
  if (kind === "ringed") {
    const back = new Graphics();
    ringHalf(back, r * 2.3, r * 0.75, false, ringColor);
    body.addChild(back);
  }
  const sphere = new Sprite({ texture: planetTexture(color, r), anchor: 0.5 });
  sphere.width = sphere.height = r * 2;
  body.addChild(sphere);
  if (kind === "ringed") {
    const front = new Graphics();
    ringHalf(front, r * 2.3, r * 0.75, true, ringColor);
    body.addChild(front);
  }
  return body;
}

/**
 * One player: a glowing body (and its trail) in the world layer; the name tag
 * and chat bubble live in the unscaled overlay so text stays crisp.
 */
export class Avatar {
  readonly id: number;
  readonly name: string;
  readonly appearance: AppearanceId;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;

  private readonly isSelf: boolean;
  private readonly color: number;
  private readonly kind: BodyKind;
  private readonly body = new Container();
  private readonly core: Container;
  private readonly trail = new Graphics();
  private readonly trailPoints: { x: number; y: number }[] = [];
  private lastTrailAt = 0;
  /** Only for the local player: a faint marker once it has faded near the edge. */
  private readonly marker: Graphics | null = null;
  private readonly tag = new Container();
  private readonly label: Text;
  private bubble: Container | null = null;
  private bubbleUntil = 0;
  private readonly samples: Sample[] = [];

  constructor(info: PlayerInfo, trails: Container, bodies: Container, overlay: Container, isSelf: boolean) {
    this.id = info.id;
    this.name = info.name;
    this.appearance = info.appearance;
    this.x = info.x;
    this.y = info.y;
    this.dir = info.dir;
    this.moving = info.moving;
    this.isSelf = isSelf;

    const look = appearanceOf(info.appearance);
    this.color = look.color;
    this.kind = look.kind;

    const glow = new Sprite({ texture: glowTexture(), anchor: 0.5, blendMode: "add", tint: this.color });
    glow.width = glow.height = SIZES[this.kind].glow;
    this.core = drawBody(this.kind, this.color);
    this.body.addChild(glow, this.core);
    bodies.addChild(this.body);
    if (isSelf) {
      // Outside the body so it does not fade with it.
      this.marker = new Graphics().circle(0, 0, 26).stroke({ color: 0xffffff, width: 1.5, alpha: 1 });
      this.marker.alpha = 0;
      bodies.addChild(this.marker);
    }
    this.trail.blendMode = "add";
    trails.addChild(this.trail);

    this.label = new Text({
      text: info.name,
      style: {
        fontFamily: "Space Grotesk, system-ui, sans-serif",
        fontSize: 13,
        fontWeight: "500",
        fill: isSelf ? 0xffe9a8 : 0xe8ecff,
        stroke: { color: 0x05060d, width: 4, join: "round" },
      },
    });
    this.label.anchor.set(0.5, 1);
    this.tag.addChild(this.label);
    overlay.addChild(this.tag);

    this.pushSample(performance.now(), info);
  }

  /** Update facing and motion (drives the trail). */
  setMotion(dir: Direction, moving: boolean): void {
    this.dir = dir;
    this.moving = moving;
  }

  pushSample(t: number, s: { x: number; y: number; dir: Direction; moving: boolean }): void {
    // Snapshots skip idle players, so after a pause the previous sample can be
    // seconds old. Re-anchor it one tick back so the move starts from rest
    // instead of being blended across the whole pause.
    const last = this.samples.at(-1);
    if (last && t - last.t > SAMPLE_GAP_MS) this.samples.push({ ...last, t: t - 1000 / TICK_RATE });
    this.samples.push({ t, x: s.x, y: s.y, dir: s.dir, moving: s.moving });
    if (this.samples.length > 30) this.samples.shift();
  }

  /** Blend buffered server samples for a remote player. */
  interpolate(now: number): void {
    const renderT = now - INTERPOLATION_DELAY_MS;
    const s = this.samples;
    while (s.length >= 2 && s[1].t <= renderT) s.shift();

    const a = s[0];
    const b = s[1];
    if (!b || renderT <= a.t) {
      this.x = a.x;
      this.y = a.y;
      this.setMotion(a.dir, a.moving);
      return;
    }
    const k = (renderT - a.t) / (b.t - a.t);
    this.x = a.x + (b.x - a.x) * k;
    this.y = a.y + (b.y - a.y) * k;
    this.setMotion(b.dir, b.moving);
  }

  showBubble(text: string): void {
    this.bubble?.destroy({ children: true });

    const content = new Text({
      text,
      style: {
        fontFamily: "Space Grotesk, system-ui, sans-serif",
        fontSize: 13,
        fill: 0x0d1024,
        wordWrap: true,
        wordWrapWidth: BUBBLE_MAX_WIDTH,
        breakWords: true,
      },
    });
    const padX = 10;
    const padY = 6;
    const w = content.width + padX * 2;
    const h = content.height + padY * 2;
    const bg = new Graphics()
      .roundRect(-w / 2, -h - 7, w, h, 10)
      .fill({ color: 0xf1f3ff, alpha: 0.96 })
      .poly([-5, -8, 5, -8, 0, 0])
      .fill({ color: 0xf1f3ff, alpha: 0.96 });
    content.position.set(-w / 2 + padX, -h - 7 + padY);

    this.bubble = new Container();
    this.bubble.addChild(bg, content);
    this.bubble.y = -this.label.height - 4;
    this.tag.addChild(this.bubble);
    this.bubbleUntil = performance.now() + BUBBLE_MS;
  }

  /** Sync the drawing with the current position; call once per frame after the camera moves. */
  render(now: number, worldX: number, worldY: number, zoom: number): void {
    const brightness = brightnessAt(this.x, this.y);
    const scale = Math.max(1, MIN_SCREEN_SCALE / zoom);
    this.body.position.set(this.x, this.y);
    this.body.scale.set(scale);
    this.body.alpha = brightness;
    if (this.kind === "star") this.core.rotation = now * 0.0006;
    if (this.marker) {
      this.marker.position.set(this.x, this.y);
      this.marker.scale.set(scale);
      this.marker.alpha = Math.max(0, 0.55 - brightness) * 1.6;
    }

    this.renderTrail(now, brightness, scale);

    const radius = SIZES[this.kind].core * 2.2 * scale * zoom;
    this.tag.position.set(Math.round(worldX + this.x * zoom), Math.round(worldY + this.y * zoom - radius - 6));
    // Faded players disappear from view, name and bubble included; you still see your own.
    this.tag.alpha = this.isSelf ? Math.max(brightness, 0.6) : brightness;
    this.tag.visible = this.tag.alpha > 0.02;

    if (this.bubble) {
      const left = this.bubbleUntil - now;
      if (left <= 0) {
        this.bubble.destroy({ children: true });
        this.bubble = null;
      } else {
        this.bubble.alpha = Math.min(1, left / 400);
      }
    }
  }

  private renderTrail(now: number, brightness: number, scale: number): void {
    const pts = this.trailPoints;
    if (this.moving && now - this.lastTrailAt >= TRAIL_EVERY_MS) {
      pts.push({ x: this.x, y: this.y });
      if (pts.length > TRAIL_POINTS) pts.shift();
      this.lastTrailAt = now;
    } else if (!this.moving && pts.length > 0 && now - this.lastTrailAt >= TRAIL_EVERY_MS) {
      pts.shift(); // let the trail shrink away once stopped
      this.lastTrailAt = now;
    }
    this.trail.clear();
    if (pts.length < 2 || brightness <= 0) return;
    const width = SIZES[this.kind].core * 1.1 * scale;
    for (let i = 1; i < pts.length; i++) {
      const k = i / pts.length;
      this.trail
        .moveTo(pts[i - 1].x, pts[i - 1].y)
        .lineTo(pts[i].x, pts[i].y)
        .stroke({ color: this.color, width: width * k, alpha: 0.5 * k * brightness, cap: "round" });
    }
    const head = pts.at(-1)!;
    this.trail.moveTo(head.x, head.y).lineTo(this.x, this.y).stroke({
      color: this.color,
      width,
      alpha: 0.5 * brightness,
      cap: "round",
    });
  }

  destroy(): void {
    this.body.destroy({ children: true });
    this.marker?.destroy();
    this.trail.destroy();
    this.tag.destroy({ children: true });
  }
}
