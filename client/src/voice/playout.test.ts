import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAYOUT, PlayoutClock } from "./playout.ts";

const FRAME = 0.02;
/** Spurts of 2 s, 0.6 s apart; the odd period keeps them out of step with server bursts. */
const SPURT_EVERY = 2.613;

/**
 * Simulate `seconds` of speech delivered in server bursts every `burst` s, each
 * burst delayed by `jitter()` and kept in order (TCP). Counts frames that started
 * after the previous one ended (audible gaps), in total and in the second half.
 */
function simulate(seconds: number, burst: number, jitter: () => number) {
  const clock = new PlayoutClock();
  let lastArrival = 0;
  let prevEnd = -Infinity;
  let gaps = 0;
  let lateGaps = 0;
  for (let t0 = 0; t0 < seconds; t0 += SPURT_EVERY) {
    for (let k = 0; k < 2 / FRAME; k++) {
      const sent = Math.ceil((t0 + (k + 1) * FRAME) / burst) * burst;
      const arrival = Math.max(lastArrival, sent + jitter());
      lastArrival = arrival;
      const start = clock.schedule(arrival, FRAME, k > 0)!;
      if (k > 0 && start > prevEnd + 1e-9) {
        gaps++;
        if (t0 > seconds / 2) lateGaps++;
      }
      prevEnd = start + FRAME;
    }
  }
  return { clock, gaps, lateGaps };
}

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

test("a clean network with 50 ms bursts goes down to the minimum delay, gap-free", () => {
  const { clock, gaps } = simulate(120, 0.05, () => 0.03);
  assert.equal(gaps, 0);
  assert.ok(Math.abs(clock.target - PLAYOUT.min) < 1e-9, `target ${clock.target}`);
});

test("100 ms bursts (idle room) settle a little higher, gap-free", () => {
  const { clock, gaps } = simulate(120, 0.1, () => 0.03);
  assert.equal(gaps, 0);
  assert.ok(clock.target >= 0.09 && clock.target <= 0.14, `target ${clock.target}`);
});

test("jitter grows the delay until gaps become rare", () => {
  const random = seeded(7);
  const { clock, gaps, lateGaps } = simulate(300, 0.05, () => 0.03 + random() * 0.18);
  assert.ok(gaps > 0);
  assert.ok(lateGaps <= 2, `gaps in the second half: ${lateGaps}`);
  assert.ok(clock.target >= 0.15, `target ${clock.target}`);
});

test("TCP stalls push the delay up, never past the cap", () => {
  const random = seeded(3);
  const { clock, lateGaps } = simulate(300, 0.05, () => (random() < 0.03 ? 0.33 : 0.03));
  assert.ok(clock.target > 0.3 && clock.target <= PLAYOUT.max, `target ${clock.target}`);
  assert.ok(lateGaps <= 2, `gaps in the second half: ${lateGaps}`);
});

test("a backlog (2 s arriving at once after a stall) is capped, not queued", () => {
  const clock = new PlayoutClock();
  const starts = Array.from({ length: 100 }, (_, k) => clock.schedule(0, FRAME, k > 0));
  const kept = starts.filter((s) => s !== null);
  assert.ok(kept.length < 60, `kept ${kept.length}`);
  assert.ok(Math.max(...kept) <= PLAYOUT.maxLead);
});
