import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMove, decodeSnapshot, encodeMove, encodeSnapshot } from "./protocol.ts";

test("move round-trips through the binary encoding", () => {
  const buf = encodeMove(123.5, 456.25, "west", true);
  assert.deepEqual(decodeMove(new DataView(buf)), { x: 123.5, y: 456.25, dir: "west", moving: true });
});

test("move rejects malformed frames", () => {
  assert.equal(decodeMove(new DataView(new ArrayBuffer(3))), null);
  const buf = encodeMove(1, 2, "north", false);
  new DataView(buf).setFloat32(1, NaN);
  assert.equal(decodeMove(new DataView(buf)), null);
});

test("snapshot round-trips every player", () => {
  const players = [
    { id: 1, x: 10, y: 20, dir: "south" as const, moving: false },
    { id: 65535, x: 1199.5, y: 0.5, dir: "east" as const, moving: true },
  ];
  const bytes = encodeSnapshot(players);
  assert.deepEqual(decodeSnapshot(new DataView(bytes.buffer)), players);
});

test("snapshot rejects a truncated frame", () => {
  const bytes = encodeSnapshot([{ id: 1, x: 0, y: 0, dir: "south", moving: false }]);
  assert.equal(decodeSnapshot(new DataView(bytes.buffer, 0, bytes.length - 1)), null);
});
