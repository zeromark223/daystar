import assert from "node:assert/strict";
import { test } from "node:test";
import { Overcharge } from "./overcharge.ts";

const calm = { loopP99Ms: 5, cpu: 0.2, egressMbps: 100 };

test("a calm server stays at 20 Hz", () => {
  const changes: number[] = [];
  const o = new Overcharge(null, (r) => changes.push(r));
  for (let i = 0; i < 60; i++) o.observe(calm);
  assert.equal(o.rate, 20);
  assert.deepEqual(changes, []);
});

test("sustained heat steps the rate down 2 Hz every 5 s, down to 10", () => {
  const changes: number[] = [];
  const o = new Overcharge(null, (r) => changes.push(r));
  for (let i = 0; i < 4; i++) o.observe({ ...calm, cpu: 0.8 });
  assert.equal(o.rate, 20); // not yet: 4 s
  for (let i = 0; i < 60; i++) o.observe({ ...calm, cpu: 0.8 });
  assert.deepEqual(changes, [18, 16, 14, 12, 10]);
});

test("one GC spike in the loop does not count; a slow loop does", () => {
  const o = new Overcharge(null, () => {});
  for (let i = 0; i < 20; i++) o.observe({ ...calm, loopP99Ms: i % 5 === 0 ? 120 : 5 });
  assert.equal(o.rate, 20);
  for (let i = 0; i < 10; i++) o.observe({ ...calm, loopP99Ms: 45 });
  assert.equal(o.rate, 18);
});

test("the egress budget counts only when set", () => {
  const busyLink = { ...calm, egressMbps: 600 };
  const free = new Overcharge(null, () => {});
  const capped = new Overcharge(700, () => {});
  for (let i = 0; i < 7; i++) {
    free.observe(busyLink);
    capped.observe(busyLink);
  }
  assert.equal(free.rate, 20);
  assert.equal(capped.rate, 18);
});

test("it climbs back only when the higher rate would still fit, without bouncing", () => {
  const changes: number[] = [];
  const o = new Overcharge(1000, (r) => changes.push(r));
  // Egress is proportional to the rate: 40 Mbps per Hz (800 at 20 Hz -> 0.8 of the budget).
  const at = (rate: number) => ({ loopP99Ms: 5, cpu: 0.1, egressMbps: 40 * rate });
  for (let i = 0; i < 120; i++) o.observe(at(o.rate));
  // 18 Hz = 720 Mbps (0.72): not hot, but back at 20 Hz it would be 0.8 again, so it stays.
  assert.equal(o.rate, 18);
  assert.deepEqual(changes, [18]);
});

test("once the load is gone it climbs back to 20 Hz, one step per 10 s", () => {
  const changes: number[] = [];
  const o = new Overcharge(null, (r) => changes.push(r));
  for (let i = 0; i < 30; i++) o.observe({ ...calm, cpu: 0.9 });
  assert.equal(o.rate, 10);
  changes.length = 0;
  for (let i = 0; i < 9; i++) o.observe(calm);
  assert.equal(o.rate, 10);
  for (let i = 0; i < 60; i++) o.observe(calm);
  assert.deepEqual(changes, [12, 14, 16, 18, 20]);
});
