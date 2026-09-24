import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CollisionMap } from "./collision.ts";
import { SPAWN_POINT } from "./constants.ts";

const map = CollisionMap.parse(
  readFileSync(new URL("../../client/public/assets/collision.txt", import.meta.url), "utf8"),
);

test("spawn point is walkable", () => {
  assert.ok(map.canStandAt(SPAWN_POINT.x, SPAWN_POINT.y));
});

test("outside the map is blocked", () => {
  assert.equal(map.canStandAt(20, 20), false);
  assert.equal(map.canStandAt(-10, 600), false);
  assert.equal(map.canStandAt(1300, 600), false);
});

test("walls stop movement but let the other axis slide", () => {
  // Walk far west from spawn: the courtyard wall must stop us well before the map edge.
  let pos = { ...SPAWN_POINT };
  for (let i = 0; i < 400; i++) pos = map.moveWithCollision(pos.x, pos.y, -2, 0);
  assert.ok(pos.x > 150, `walked through walls to x=${pos.x}`);
  assert.equal(pos.y, SPAWN_POINT.y);
});

test("serialize round-trips and edits apply", () => {
  const copy = CollisionMap.parse(map.serialize());
  assert.equal(copy.serialize(), map.serialize());
  assert.equal(copy.setCell(0, 0, true), true);
  assert.equal(copy.setCell(0, 0, true), false);
  assert.ok(copy.isCellWalkable(0, 0));
});

test("parse rejects malformed input", () => {
  assert.throws(() => CollisionMap.parse("..##\n"));
  assert.throws(() => CollisionMap.parse("cell=4\n..#\n.x#\n"));
  assert.throws(() => CollisionMap.parse("cell=4\n..#\n..\n"));
});

test("character heights match the generated spritesheets", async () => {
  const { CHARACTERS, CHARACTER_IDS } = await import("./characters.ts");
  for (const id of CHARACTER_IDS) {
    const sheet = JSON.parse(
      readFileSync(new URL(`../../client/public/assets/characters/${id}.json`, import.meta.url), "utf8"),
    );
    assert.equal(CHARACTERS[id].height, sheet.meta.height, id);
  }
});

test("collision offset moves the box up from the feet", () => {
  // A point just below a wall is fine for feet but blocked once the box is raised into the wall.
  const x = SPAWN_POINT.x;
  let y = SPAWN_POINT.y;
  while (map.canStandAt(x, y - 1)) y--;
  assert.ok(map.canStandAt(x, y));
  assert.equal(map.canStandAt(x, y + 10, 10), map.canStandAt(x, y));
  assert.equal(map.canStandAt(x, y, 10), false);
});
