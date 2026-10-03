import assert from "node:assert/strict";
import { test } from "node:test";
import { cellOf, cellsInView, cellsMeet, fogAt, inView } from "./aoi.ts";
import { AOI_FOG_END, AOI_FOG_START, AOI_RADIUS } from "./constants.ts";
import { canBeAt } from "./space.ts";

test("everyone within AOI_RADIUS of a viewer is in view of the viewer's cell", () => {
  for (let i = 0; i < 2000; i++) {
    const vx = 1000 + Math.random() * 8000;
    const vy = 1000 + Math.random() * 8000;
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * AOI_RADIUS;
    const px = vx + Math.cos(a) * d;
    const py = vy + Math.sin(a) * d;
    if (!canBeAt(vx, vy) || !canBeAt(px, py)) continue; // players stay in the world
    const cell = cellOf(vx, vy);
    assert.ok(inView(px, py, cell), `${px},${py} from ${vx},${vy}`);
    assert.ok(cellsMeet(cell, cellOf(px, py)));
    assert.ok(cellsInView(cell).includes(cellOf(px, py)));
  }
});

test("players far away are not in view", () => {
  assert.ok(!inView(9000, 9000, cellOf(1000, 1000)));
  assert.ok(!cellsMeet(cellOf(1000, 1000), cellOf(9000, 9000)));
});

test("fog: clear, then fading, then gone", () => {
  assert.equal(fogAt(0), 1);
  assert.equal(fogAt(AOI_FOG_START), 1);
  assert.ok(fogAt((AOI_FOG_START + AOI_FOG_END) / 2) > 0.4 && fogAt((AOI_FOG_START + AOI_FOG_END) / 2) < 0.6);
  assert.equal(fogAt(AOI_FOG_END), 0);
  assert.ok(AOI_FOG_END < AOI_RADIUS);
});
