import type { Direction } from "../../../shared/src/direction.ts";

/**
 * Drawing other players smoothly. Snapshots carry the server's time at the tick
 * and, per player, how long before it the server got that position, so every
 * position has a server timestamp. Remote players are drawn on the server's
 * timeline a little in the past: far enough that the next position has usually
 * arrived, which turns network jitter and uneven sends into steady motion.
 * (Stamping positions with their arrival time instead made them speed up and
 * stall at random: tools/smoothness.ts.)
 *
 * Pure logic, no PixiJS: the load-test probe uses it too.
 */

/** Window over which arrivals are judged (fastest delivery, jitter). */
const WINDOW_MS = 4_000;
/** Players send their position this often (client SEND_INTERVAL_MS). */
const SEND_INTERVAL_MS = 50;
/** Spare time on top of the measured needs. */
const MARGIN_MS = 10;
/** The delay follows its target at most this fast: a 5 or 10% change in playback speed nobody notices. */
const SLOWER_PER_MS = 0.1;
const FASTER_PER_MS = 0.05;
/** Past the newest position, keep a moving player going this long before it stops. */
export const MAX_EXTRAPOLATE_MS = 80;

/**
 * Maps server time to what to draw now. `observe` every snapshot's time;
 * `renderTime` once per frame gives the server time to draw remote players at.
 */
export class PlayoutClock {
  /** Time between snapshots for this client (server announced). */
  intervalMs = 50;
  private lastRaw = -1;
  private serverTime = 0;
  private readonly arrivals: { at: number; late: number }[] = [];
  /** now - serverTime of the fastest arrival in the window: the clock offset plus the network's minimum. */
  private fastest = Infinity;
  /** How far behind the server's clock to draw: wanted, and as drawn (moves slowly towards wanted). */
  private target = NaN;
  private lag = NaN;
  private lastFrame = NaN;

  /** A new server (migration) or a rejoin: start over. */
  reset(): void {
    this.lastRaw = -1;
    this.arrivals.length = 0;
    this.target = this.lag = this.lastFrame = NaN;
  }

  /** The newest server time seen, for positions that come without one (welcome, view). */
  get latest(): number {
    return this.serverTime;
  }

  /** A snapshot stamped `raw` (server Unix ms modulo 2^32) arrived at local time `now`; returns its server time. */
  observe(raw: number, now: number): number {
    // Unwrapped through 32-bit differences, so the modulo never shows.
    this.serverTime = this.lastRaw < 0 ? raw : this.serverTime + ((raw - this.lastRaw) | 0);
    this.lastRaw = raw;
    this.arrivals.push({ at: now, late: now - this.serverTime });
    while (this.arrivals.length > 0 && now - this.arrivals[0].at > WINDOW_MS) this.arrivals.shift();
    let fastest = Infinity;
    for (const a of this.arrivals) fastest = Math.min(fastest, a.late);
    this.fastest = fastest;
    // How much later than the fastest the slow ones come (95th percentile).
    const lateness = this.arrivals.map((a) => a.late - fastest).sort((x, y) => x - y);
    const jitter = lateness[Math.floor(lateness.length * 0.95)] ?? 0;
    // The newest position of a player can be up to one send old at the tick, and
    // the next snapshot comes one interval later, plus jitter.
    this.target = fastest + this.intervalMs + SEND_INTERVAL_MS + jitter + MARGIN_MS;
    return this.serverTime;
  }

  /** Server time to draw remote players at, local time `now`. Call once per frame. */
  renderTime(now: number): number {
    if (Number.isNaN(this.target)) return this.serverTime;
    if (Number.isNaN(this.lag)) this.lag = this.target;
    const dt = Number.isNaN(this.lastFrame) ? 0 : Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    // Changes (more jitter, the fastest arrival leaving the window) become a
    // slightly slower or faster playback instead of a jump.
    const step = this.target - this.lag;
    this.lag += step > 0 ? Math.min(step, dt * SLOWER_PER_MS) : Math.max(step, -dt * FASTER_PER_MS);
    return now - this.lag;
  }

  /** How far behind the newest snapshot we draw, in ms (for debugging). */
  get delayMs(): number {
    return this.lag - this.fastest;
  }
}

export interface Sample {
  t: number;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
}

/**
 * One remote player's positions on the server timeline, and where to draw it.
 * Snapshots skip idle players, so a gap means it stood still: the move then
 * starts from rest instead of being blended across the whole pause.
 */
export class Track {
  private readonly samples: Sample[] = [];
  /** Velocity of the last segment (px/ms), to carry a moving player briefly past its newest position. */
  private vx = 0;
  private vy = 0;
  /** A gap longer than this between positions means the player was idle. */
  static idleGapMs = 150;

  get empty(): boolean {
    return this.samples.length === 0;
  }

  clear(): void {
    this.samples.length = 0;
    this.vx = this.vy = 0;
  }

  push(s: Sample): void {
    const last = this.samples.at(-1);
    if (last) {
      // Same or older time: a duplicate (e.g. a view after a snapshot); keep the newer state.
      if (s.t <= last.t) {
        Object.assign(last, { x: s.x, y: s.y, dir: s.dir, moving: s.moving });
        return;
      }
      if (s.t - last.t > Track.idleGapMs) this.samples.push({ ...last, t: s.t - SEND_INTERVAL_MS });
    }
    this.samples.push({ ...s });
    if (this.samples.length > 40) this.samples.shift();
  }

  /** Where to draw at server time `t`; null before any position. */
  at(t: number): Sample | null {
    const s = this.samples;
    while (s.length >= 2 && s[1].t <= t) {
      const [a, b] = s;
      const span = b.t - a.t;
      if (span > 0) {
        this.vx = (b.x - a.x) / span;
        this.vy = (b.y - a.y) / span;
      }
      s.shift();
    }
    const a = s[0];
    if (!a) return null;
    const b = s[1];
    if (b && t > a.t) {
      const k = (t - a.t) / (b.t - a.t);
      return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, dir: b.dir, moving: b.moving };
    }
    if (!b && a.moving && t > a.t) {
      // Late data: keep going a little rather than stop and jump.
      const ahead = Math.min(t - a.t, MAX_EXTRAPOLATE_MS);
      return { ...a, t, x: a.x + this.vx * ahead, y: a.y + this.vy * ahead };
    }
    return a;
  }
}
