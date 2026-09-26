import assert from "node:assert/strict";
import { test } from "node:test";
import { SUN_RADIUS, WORLD_CENTER, WORLD_RADIUS } from "./constants.ts";
import { brightnessAt, canBeAt, constrain, distanceFromCenter, moveInSpace, spawnPoint } from "./space.ts";

const at = (r: number, angle = 0) => ({ x: WORLD_CENTER.x + Math.cos(angle) * r, y: WORLD_CENTER.y + Math.sin(angle) * r });

test("players live between the sun and the edge", () => {
  const ok = at(2000);
  assert.ok(canBeAt(ok.x, ok.y));
  const inSun = at(SUN_RADIUS - 10);
  assert.equal(canBeAt(inSun.x, inSun.y), false);
  const outside = at(WORLD_RADIUS + 10);
  assert.equal(canBeAt(outside.x, outside.y), false);
  assert.equal(canBeAt(NaN, 0), false);
});

test("moves stop at the sun and at the edge, keeping the direction", () => {
  const edge = moveInSpace(at(WORLD_RADIUS - 5).x, WORLD_CENTER.y, 50, 0);
  assert.ok(distanceFromCenter(edge.x, edge.y) <= WORLD_RADIUS);
  assert.ok(canBeAt(edge.x, edge.y));
  const sun = moveInSpace(at(SUN_RADIUS + 5).x, WORLD_CENTER.y, -50, 0);
  assert.ok(distanceFromCenter(sun.x, sun.y) >= SUN_RADIUS);
  assert.ok(sun.x > WORLD_CENTER.x);
  const center = constrain(WORLD_CENTER.x, WORLD_CENTER.y);
  assert.ok(canBeAt(center.x, center.y));
});

test("brightness is full inside, fades near the edge, and is zero at it", () => {
  const inside = at(WORLD_RADIUS * 0.5);
  assert.equal(brightnessAt(inside.x, inside.y), 1);
  const start = at(WORLD_RADIUS * 0.6);
  assert.equal(brightnessAt(start.x, start.y), 1);
  const mid = at(WORLD_RADIUS * 0.8);
  assert.ok(Math.abs(brightnessAt(mid.x, mid.y) - 0.5) < 1e-9);
  const edge = at(WORLD_RADIUS);
  assert.equal(brightnessAt(edge.x, edge.y), 0);
});

test("newcomers appear near someone, or on the ring when alone", () => {
  let seed = 0.37;
  const random = () => (seed = (seed * 9301 + 0.49297) % 1);
  const friend = at(3000, 1);
  for (let i = 0; i < 20; i++) {
    const p = spawnPoint([friend], random);
    assert.ok(Math.hypot(p.x - friend.x, p.y - friend.y) <= 321);
    assert.ok(canBeAt(p.x, p.y));
    const alone = spawnPoint([], random);
    const r = distanceFromCenter(alone.x, alone.y);
    assert.ok(r >= 900 && r <= 1600);
  }
});
