import { Container, Graphics, Mesh, Point, RopeGeometry, Sprite, Texture } from "pixi.js";
import { SUN_RADIUS, WORLD_CENTER } from "../../../shared/src/constants.ts";
import { glowTexture } from "./textures.ts";

/**
 * The "corona" gather (the default; it beat the fly-in in an A/B test): a reverse
 * big bang at the sun. A flash and a shock wave, streams of light whirling round
 * the sun, then the streams stretch out like a corona and fade. Players are put
 * in their seats at once, hidden, and appear as it fades (Game drives that).
 * It costs the same with 10 players or 5,000: a fixed set of streams.
 *
 * Each stream is a rope mesh along a few points with one shared texture that
 * already holds its look (bright core, faint glow, thinner and dimmer towards
 * the tip), tinted per stream. Moving a stream only moves its points; drawing
 * the same streams as Graphics strokes, rebuilt every frame, halved the frame
 * rate.
 */

const STREAMS = 120;
const SEGMENTS = 14;
/** Timeline (ms). */
const FLASH_MS = 450;
const SHOCK_MS = 1_000;
const SWIRL_FROM = 150;
const SWIRL_MS = 1_750;
const CORONA_FROM = 1_300;
const CORONA_MS = 1_900;
export const CORONA_MS_TOTAL = CORONA_FROM + CORONA_MS;
/**
 * With the burst (the sun flares as the streams start stretching out) players
 * shoot out from beside the sun to their seats, riding the streams; the inner
 * rings leave a little earlier. See Game.coronaPosition.
 */
export const CORONA_BURST_AT = 1_550;
export const CORONA_OUT_MS = 1_300;
export const CORONA_OUT_STAGGER_MS = 250;

const COLORS = [0xfff1c1, 0xffd166, 0xff8c5a, 0xffe08a, 0xffffff, 0xb38cff, 0x6cb8ff, 0xff7eb6];
const TURNS_PER_SEC = 0.9;

const clamp01 = (k: number) => Math.min(1, Math.max(0, k));
const easeOut = (k: number) => 1 - (1 - k) ** 3;

/** Rope thickness over the core's: the rest is glow. */
const GLOW = 2.6;
let streamTexture: Texture | null = null;

/**
 * White on transparent; x runs from the sun (left) to the tip (right), y across.
 * A narrow bright core inside a wide soft glow, narrowing to 65% and fading to
 * half towards the tip, with a soft end.
 */
function streamLook(): Texture {
  if (streamTexture) return streamTexture;
  const w = 256;
  const h = 64;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const u = x / (w - 1);
    const narrow = 1 - 0.35 * u;
    const fade = (1 - 0.5 * u) * Math.min(1, (1 - u) / 0.12);
    for (let y = 0; y < h; y++) {
      const v = (y - (h - 1) / 2) / (h / 2);
      const core = Math.exp(-4 * (v / ((narrow * 1) / GLOW)) ** 2) * 0.9;
      const glow = Math.exp(-3 * (v / (narrow * 0.9)) ** 2) * 0.22;
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * Math.min(1, (core + glow) * fade));
    }
  }
  ctx.putImageData(img, 0, 0);
  streamTexture = Texture.from(canvas);
  return streamTexture;
}

interface Stream {
  angle: number;
  /** How far round the sun the stream wraps (radians) while it whirls. */
  twist: number;
  width: number;
  color: number;
  /** Direction of turn and a little speed variety. */
  spin: number;
  points: Point[];
  geometry: RopeGeometry;
  mesh: Mesh;
}

export class CoronaEffect {
  readonly view = new Container();
  private readonly streams = new Container();
  private readonly shock = new Graphics();
  /**
   * A warm rim over the edge of the sun while the streams whirl: without it the
   * sun's dim ray zone (between its disc and the streams) read as a dark ring.
   */
  private readonly rim = new Graphics()
    .circle(0, 0, SUN_RADIUS * 0.95)
    .stroke({ color: 0xffe2a0, width: SUN_RADIUS * 0.45, alpha: 1 })
    .circle(0, 0, SUN_RADIUS * 1.15)
    .stroke({ color: 0xffc860, width: SUN_RADIUS * 0.35, alpha: 0.5 });
  private readonly flash = new Sprite({ texture: glowTexture(), anchor: 0.5, tint: 0xfff6dc });
  private readonly halo = new Sprite({ texture: glowTexture(), anchor: 0.5, tint: 0xffb347 });
  private readonly seeds: Stream[] = [];
  private start = -1;
  private extent = 1000;

  constructor() {
    this.view.position.set(WORLD_CENTER.x, WORLD_CENTER.y);
    this.view.blendMode = "add";
    this.view.visible = false;
    this.view.addChild(this.halo, this.rim, this.streams, this.shock, this.flash);
    const look = streamLook();
    for (let i = 0; i < STREAMS; i++) {
      const points = Array.from({ length: SEGMENTS + 1 }, () => new Point());
      const geometry = new RopeGeometry({ points, width: 1 });
      const mesh = new Mesh({ geometry, texture: look });
      const color = COLORS[i % COLORS.length];
      mesh.tint = color;
      mesh.blendMode = "add";
      this.streams.addChild(mesh);
      this.seeds.push({
        angle: (i / STREAMS) * Math.PI * 2 + Math.random() * 0.1,
        twist: 1.4 + Math.random() * 1.6,
        // The core's width in screen pixels (like the fly-in's trails), whatever the zoom.
        width: 6 + Math.random() * 8,
        color,
        spin: 0.8 + Math.random() * 0.5,
        points,
        geometry,
        mesh,
      });
    }
  }

  get active(): boolean {
    return this.start >= 0;
  }

  /** Play from local time `now`; `extent` is how far the seats reach (the corona goes that far). */
  play(now: number, extent: number): void {
    this.start = now;
    this.extent = extent;
    this.view.visible = true;
  }

  stop(): void {
    this.start = -1;
    this.view.visible = false;
    this.shock.clear();
  }

  /** `zoom`: the world's scale on screen, so streams keep their width in pixels. */
  update(now: number, zoom: number): void {
    if (this.start < 0) return;
    const t = now - this.start;
    if (t >= CORONA_MS_TOTAL) {
      this.stop();
      return;
    }

    // The bang: a white flash and a shock wave racing out to the seats.
    const f = clamp01(t / FLASH_MS);
    this.flash.width = this.flash.height = SUN_RADIUS * (2 + 10 * easeOut(f));
    this.flash.alpha = 1 - f;
    this.shock.clear();
    // One shock wave at the bang, a second as everyone bursts out.
    for (const [from, color] of [[0, 0xfff1c1], [CORONA_BURST_AT, 0xffd166]] as const) {
      const sk = clamp01((t - from) / SHOCK_MS);
      if (t < from || sk >= 1) continue;
      this.shock.circle(0, 0, SUN_RADIUS + (this.extent - SUN_RADIUS) * easeOut(sk)).stroke({
        color,
        width: 6 + 30 * (1 - sk),
        alpha: 0.7 * (1 - sk),
      });
    }

    // The halo swells with the corona and fades with it.
    const c = clamp01((t - CORONA_FROM) / CORONA_MS);
    const swirl = clamp01((t - SWIRL_FROM) / SWIRL_MS);
    this.halo.width = this.halo.height = SUN_RADIUS * (4 + 10 * easeOut(c));
    this.halo.alpha = Math.min(1, swirl * 3) * (1 - c * c) * 0.9;

    // Streams: arcs whirling round the sun, then stretching out and unwinding.
    const fadeIn = clamp01((t - SWIRL_FROM) / 300);
    const alpha = fadeIn * (1 - c * c);
    this.rim.alpha = alpha * 0.55;
    this.streams.visible = alpha > 0.01;
    if (!this.streams.visible) return;
    // From under the edge of the sun's disc (0.78 R), so they pour out of it.
    const inner = SUN_RADIUS * 0.72;
    const px = 1 / Math.max(0.05, zoom);
    const whirlOut = SUN_RADIUS * (1.25 + 1.5 * easeOut(swirl));
    const outer = whirlOut + (this.extent * 0.95 - whirlOut) * easeOut(c);
    for (const s of this.seeds) {
      const rotation = s.angle + s.spin * TURNS_PER_SEC * Math.PI * 2 * (t / 1000);
      const twist = s.twist * (1 - easeOut(c));
      for (let j = 0; j <= SEGMENTS; j++) {
        const k = j / SEGMENTS;
        const r = inner + (outer - inner) * k;
        const a = rotation + twist * k;
        s.points[j].set(Math.cos(a) * r, Math.sin(a) * r);
      }
      // RopeGeometry keeps its width private; set it in world units for the wanted pixels.
      (s.geometry as unknown as { _width: number })._width = s.width * GLOW * px;
      s.geometry.updateVertices();
      s.mesh.alpha = alpha;
    }
  }
}

/** Burning trails behind players bursting out (at most this many at once, the nearest to the middle). */
export const MAX_BURST_TRAILS = 500;
/** Points per trail. */
export const BURST_TRAIL_POINTS = 10;

/**
 * White-hot trails behind players as they burst out to their seats, like the
 * fly-in's streaks: rope meshes sharing the stream texture, taken from a pool
 * each frame. Game gives each one its path (head first), computed, not traced.
 */
export class BurstTrails {
  readonly view = new Container();
  private readonly ropes: { points: Point[]; geometry: RopeGeometry; mesh: Mesh }[] = [];
  private used = 0;

  constructor() {
    this.view.blendMode = "add";
  }

  begin(): void {
    this.used = 0;
  }

  /** `path`: BURST_TRAIL_POINTS + 1 points, head first; `width` in world units. */
  add(path: { x: number; y: number }[], width: number, alpha: number): void {
    if (this.used >= MAX_BURST_TRAILS) return;
    let rope = this.ropes[this.used];
    if (!rope) {
      const points = Array.from({ length: BURST_TRAIL_POINTS + 1 }, () => new Point());
      const geometry = new RopeGeometry({ points, width: 1 });
      const mesh = new Mesh({ geometry, texture: streamLook() });
      mesh.tint = 0xfff4dc;
      mesh.blendMode = "add";
      this.view.addChild(mesh);
      rope = { points, geometry, mesh };
      this.ropes.push(rope);
    }
    for (let i = 0; i < rope.points.length; i++) rope.points[i].set(path[i].x, path[i].y);
    (rope.geometry as unknown as { _width: number })._width = width;
    rope.geometry.updateVertices();
    rope.mesh.alpha = alpha;
    rope.mesh.visible = true;
    this.used++;
  }

  /** Hide the ropes nobody used this frame. */
  end(): void {
    for (let i = this.used; i < this.ropes.length; i++) this.ropes[i].mesh.visible = false;
  }
}
