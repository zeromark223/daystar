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

test("walls stop movement", () => {
  // Walk far west from spawn: the courtyard wall must stop us well before the map edge.
  let pos = { ...SPAWN_POINT };
  for (let i = 0; i < 400; i++) pos = map.moveWithCollision(pos.x, pos.y, -2, 0);
  assert.ok(pos.x > 150, `walked through walls to x=${pos.x}`);
  assert.ok(map.canStandAt(pos.x, pos.y));
});

/** 30x30 cells of 4px; cells below the diagonal (row > column) are walkable. */
function diagonalMap(): CollisionMap {
  const rows = [];
  for (let y = 0; y < 30; y++) {
    let row = "";
    for (let x = 0; x < 30; x++) row += y > x ? "." : "#";
    rows.push(row);
  }
  return CollisionMap.parse(`cell=4\n${rows.join("\n")}\n`);
}

test("the body is a circle", () => {
  const m = diagonalMap();
  // Cell (10, 11) is walkable, its blocked neighbour (11, 11) starts at x=44.
  assert.ok(m.canStandAt(40, 50)); // 4px from the blocked cell edge: just touching
  assert.equal(m.canStandAt(41, 50), false);
});

test("pushing straight into a diagonal wall glides along it", () => {
  const m = diagonalMap();
  let pos = { x: 30, y: 90 };
  // Hold "up": the wall is diagonal, so without gliding we would stop at the first step.
  for (let i = 0; i < 100; i++) pos = m.moveWithCollision(pos.x, pos.y, 0, -1);
  assert.ok(pos.y < 40, `stuck at y=${pos.y}`);
  assert.ok(m.canStandAt(pos.x, pos.y));
});

test("gliding never cuts through a flat wall", () => {
  const m = diagonalMap();
  // Hold "left" against the map edge (x=0 is outside the grid).
  let pos = { x: 20, y: 100 };
  for (let i = 0; i < 100; i++) pos = m.moveWithCollision(pos.x, pos.y, -2, 0);
  assert.ok(pos.x >= 4);
  assert.ok(Math.abs(pos.y - 100) <= 2, `drifted to y=${pos.y}`);
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

test("collision offset moves the body up from the feet", () => {
  // A point just below a wall is fine for feet but blocked once the body is raised into the wall.
  const x = SPAWN_POINT.x;
  let y = SPAWN_POINT.y;
  while (map.canStandAt(x, y - 1)) y--;
  assert.ok(map.canStandAt(x, y));
  assert.equal(map.canStandAt(x, y + 10, 10), map.canStandAt(x, y));
  assert.equal(map.canStandAt(x, y, 10), false);
});
