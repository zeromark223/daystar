import assert from "node:assert/strict";
import { test } from "node:test";
import { canStandAt, moveWithCollision } from "./collision.ts";
import { SPAWN_POINT } from "./constants.ts";

test("spawn point is walkable", () => {
  assert.ok(canStandAt(SPAWN_POINT.x, SPAWN_POINT.y));
});

test("outside the map is blocked", () => {
  assert.equal(canStandAt(20, 20), false);
  assert.equal(canStandAt(-10, 600), false);
  assert.equal(canStandAt(1300, 600), false);
});

test("walls stop movement but let the other axis slide", () => {
  // Walk far west from spawn: the courtyard wall must stop us well before the map edge.
  let pos = { ...SPAWN_POINT };
  for (let i = 0; i < 400; i++) pos = moveWithCollision(pos.x, pos.y, -2, 0);
  assert.ok(pos.x > 150, `walked through walls to x=${pos.x}`);
  assert.equal(pos.y, SPAWN_POINT.y);
});
