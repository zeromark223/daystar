import { Container, Graphics, Sprite } from "pixi.js";
import { SUN_RADIUS, WORLD_CENTER } from "../../../shared/src/constants.ts";
import { glowTexture } from "./textures.ts";

/**
 * The "corona" gather (variant B of the A/B test against the fly-in): a reverse
 * big bang at the sun. A flash and a shock wave, streams of light whirling round
 * the sun, then the streams stretch out like a corona and fade. Players are put
 * in their seats at once, hidden, and appear as it fades (Game drives that).
 * It costs the same with 10 players or 5,000: a fixed set of streams.
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
/** Players start appearing here, the inner rings first. */
export const CORONA_REVEAL_FROM = 2_200;
export const CORONA_REVEAL_MS = 900;

const COLORS = [0xfff1c1, 0xffd166, 0xff8c5a, 0xffe08a, 0xffffff, 0xb38cff, 0x6cb8ff, 0xff7eb6];
const TURNS_PER_SEC = 0.9;

const clamp01 = (k: number) => Math.min(1, Math.max(0, k));
const easeOut = (k: number) => 1 - (1 - k) ** 3;

interface Stream {
  angle: number;
  /** How far round the sun the stream wraps (radians) while it whirls. */
  twist: number;
  width: number;
  color: number;
  /** Direction of turn and a little speed variety. */
  spin: number;
}

export class CoronaEffect {
  readonly view = new Container();
  private readonly streams = new Graphics();
  private readonly shock = new Graphics();
  private readonly flash = new Sprite({ texture: glowTexture(), anchor: 0.5, tint: 0xfff6dc });
  private readonly halo = new Sprite({ texture: glowTexture(), anchor: 0.5, tint: 0xffb347 });
  private readonly seeds: Stream[] = [];
  private start = -1;
  private extent = 1000;

  constructor() {
    this.view.position.set(WORLD_CENTER.x, WORLD_CENTER.y);
    this.view.blendMode = "add";
    this.view.visible = false;
    this.view.addChild(this.halo, this.streams, this.shock, this.flash);
    for (let i = 0; i < STREAMS; i++) {
      this.seeds.push({
        angle: (i / STREAMS) * Math.PI * 2 + Math.random() * 0.1,
        twist: 1.4 + Math.random() * 1.6,
        // Thinner than one would draw a few: they add up (additive blending).
        width: 3 + Math.random() * 6,
        color: COLORS[i % COLORS.length],
        spin: 0.8 + Math.random() * 0.5,
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
    this.streams.clear();
    this.shock.clear();
  }

  update(now: number): void {
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
    const sk = clamp01(t / SHOCK_MS);
    this.shock.clear();
    if (sk < 1) {
      this.shock.circle(0, 0, SUN_RADIUS + (this.extent - SUN_RADIUS) * easeOut(sk)).stroke({
        color: 0xfff1c1,
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
    this.streams.clear();
    const fadeIn = clamp01((t - SWIRL_FROM) / 300);
    const alpha = fadeIn * (1 - c * c);
    if (alpha <= 0.01) return;
    const inner = SUN_RADIUS * 1.05;
    const whirlOut = SUN_RADIUS * (1.25 + 1.5 * easeOut(swirl));
    const outer = whirlOut + (this.extent * 0.95 - whirlOut) * easeOut(c);
    for (const s of this.seeds) {
      const rotation = s.angle + s.spin * TURNS_PER_SEC * Math.PI * 2 * (t / 1000);
      const twist = s.twist * (1 - easeOut(c));
      let px = Math.cos(rotation) * inner;
      let py = Math.sin(rotation) * inner;
      for (let j = 1; j <= SEGMENTS; j++) {
        const k = j / SEGMENTS;
        const r = inner + (outer - inner) * k;
        const a = rotation + twist * k;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        this.streams
          .moveTo(px, py)
          .lineTo(x, y)
          .stroke({ color: s.color, width: s.width * (1 - 0.75 * k), alpha: alpha * (1 - k * 0.85), cap: "round" });
        px = x;
        py = y;
      }
    }
  }
}
