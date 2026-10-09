import assert from "node:assert/strict";
import { test } from "node:test";
import { WORLD_CENTER } from "./constants.ts";
import { freeSlot, orbitPosition, STAGE_RADIUS, STAGE_SLOTS } from "./orbit.ts";

test("seats never overlap, the stage hugs the sun, outer rings turn slower", () => {
  const seats = Array.from({ length: 3000 }, (_, s) => orbitPosition(s, 12.5));
  for (let s = 0; s < STAGE_SLOTS; s++) {
    assert.ok(Math.abs(Math.hypot(seats[s].x - WORLD_CENTER.x, seats[s].y - WORLD_CENTER.y) - STAGE_RADIUS) < 1e-6);
  }
  // Nearest neighbours by grid bucket; no two seats closer than 50 px.
  const grid = new Map<string, { x: number; y: number }[]>();
  const key = (x: number, y: number) => `${Math.floor(x / 50)},${Math.floor(y / 50)}`;
  for (const p of seats) {
    const cx = Math.floor(p.x / 50);
    const cy = Math.floor(p.y / 50);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const q of grid.get(`${cx + dx},${cy + dy}`) ?? []) assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= 50);
    grid.set(key(p.x, p.y), [...(grid.get(key(p.x, p.y)) ?? []), p]);
  }
  const speed = (s: number) => Math.hypot(orbitPosition(s, 1).x - orbitPosition(s, 0).x, orbitPosition(s, 1).y - orbitPosition(s, 0).y);
  assert.ok(speed(0) > speed(100) && speed(100) > speed(2000));
});

test("free seats: speakers on the stage while there is room, everyone else on the rings", () => {
  assert.equal(freeSlot(true, [0, 1]), 2);
  assert.equal(freeSlot(false, [0, 1]), STAGE_SLOTS);
  assert.equal(freeSlot(true, Array.from({ length: STAGE_SLOTS }, (_, i) => i)), STAGE_SLOTS);
  assert.equal(freeSlot(false, [STAGE_SLOTS, STAGE_SLOTS + 2]), STAGE_SLOTS + 1);
});
