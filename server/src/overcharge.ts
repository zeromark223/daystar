import { TICK_RATE } from "../../shared/src/constants.ts";

/**
 * Overcharge: when the server runs hot, every room sends fewer snapshots per
 * player, 2 Hz at a time (20, 18, ... 10), and climbs back once there is room
 * again. Gentle steps keep each change small for clients (their interpolation
 * delay moves by 10-25 ms), and the rate adapts to the real headroom of the
 * machine instead of a fixed player count.
 *
 * Load score: the highest of
 * - event loop p99 / 50 ms (median of the last 5 seconds, so one GC spike does not count),
 * - CPU / one core,
 * - egress / EGRESS_BUDGET_MBPS (only when set, e.g. to stay under a link's capacity).
 */
export const OVERCHARGE = {
  loopTargetMs: 50,
  cpuBudget: 1,
  /** Score that, held for `enterSec` seconds, lowers the rate one step. */
  enterAt: 0.75,
  enterSec: 5,
  /**
   * Climb back one step when, for `exitSec` seconds, CPU and egress scaled to the
   * higher rate would stay under `exitBelow` and the loop is calm. Predicting the
   * load after the step avoids bouncing between two rates.
   */
  exitBelow: 0.65,
  loopCalm: 0.5,
  exitSec: 10,
  stepHz: 2,
  minHz: 10,
  maxHz: TICK_RATE,
} as const;

export interface LoadReading {
  loopP99Ms: number;
  /** 1 = one full core. */
  cpu: number;
  egressMbps: number;
}

export class Overcharge {
  /** Snapshots per second each player gets. */
  rate: number = OVERCHARGE.maxHz;
  score = 0;
  private readonly egressBudgetMbps: number | null;
  private readonly onChange: (rate: number) => void;
  private readonly loop: number[] = [];
  private hot = 0;
  private calm = 0;

  constructor(egressBudgetMbps: number | null, onChange: (rate: number) => void) {
    this.egressBudgetMbps = egressBudgetMbps;
    this.onChange = onChange;
  }

  /** Feed one second of load (from the stats sampler). */
  observe(r: LoadReading): void {
    const o = OVERCHARGE;
    this.loop.push(r.loopP99Ms);
    if (this.loop.length > 5) this.loop.shift();
    const loopMedian = [...this.loop].sort((a, b) => a - b)[this.loop.length >> 1];
    const parts = {
      loop: loopMedian / o.loopTargetMs,
      cpu: r.cpu / o.cpuBudget,
      egress: this.egressBudgetMbps ? r.egressMbps / this.egressBudgetMbps : 0,
    };
    this.score = Math.max(parts.loop, parts.cpu, parts.egress);

    if (this.score >= o.enterAt) {
      this.hot++;
      this.calm = 0;
    } else {
      this.hot = 0;
      const up = (this.rate + o.stepHz) / this.rate;
      const roomToClimb =
        this.rate < o.maxHz && parts.cpu * up < o.exitBelow && parts.egress * up < o.exitBelow && parts.loop < o.loopCalm;
      this.calm = roomToClimb ? this.calm + 1 : 0;
    }

    if (this.hot >= o.enterSec && this.rate > o.minHz) {
      this.set(Math.max(o.minHz, this.rate - o.stepHz));
    } else if (this.calm >= o.exitSec) {
      this.set(Math.min(o.maxHz, this.rate + o.stepHz));
    }
  }

  private set(rate: number): void {
    this.rate = rate;
    // Observe the new rate for a full window before the next step.
    this.hot = 0;
    this.calm = 0;
    this.onChange(rate);
  }
}
