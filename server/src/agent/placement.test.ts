import assert from "node:assert/strict";
import { test } from "node:test";
import { overloaded, place, type RoomView, type ServerView } from "./placement.ts";

const servers = (...players: number[]): ServerView[] =>
  players.map((p, i) => ({ id: i + 1, alive: true, capacity: 100, players: p }));
const room = (home: number | null, perServer: [number, number][]): RoomView => ({ home, perServer: new Map(perServer) });

test("a new room goes to the least-loaded server", () => {
  assert.equal(place(servers(50, 10, 30), undefined, { allowSpan: true }), 2);
});

test("a room stays on its home while the home is under the soft limit", () => {
  assert.equal(place(servers(60, 0, 0), room(1, [[1, 40]]), { allowSpan: true }), 1);
});

test("a busy home spills to another server already hosting the room", () => {
  const r = room(1, [[1, 60], [3, 10]]);
  assert.equal(place(servers(80, 0, 20), r, { allowSpan: true }), 3);
});

test("when every host is busy the room spans to the least-loaded server", () => {
  const r = room(1, [[1, 60], [2, 60]]);
  assert.equal(place(servers(80, 75, 5, 20), r, { allowSpan: true }), 3);
});

test("without spanning, a room always stays on its server even when busy", () => {
  const r = room(1, [[1, 95]]);
  assert.equal(place(servers(95, 0), r, { allowSpan: false }), 1);
});

test("a room whose home died moves to a surviving host, else anywhere", () => {
  const dead: ServerView[] = servers(10, 20, 30).map((s) => (s.id === 1 ? { ...s, alive: false } : s));
  assert.equal(place(dead, room(1, [[1, 5], [3, 5]]), { allowSpan: false }), 3);
  assert.equal(place(dead, room(1, [[1, 5]]), { allowSpan: false }), 2);
});

test("excluded and dead servers are never chosen; none left gives null", () => {
  assert.equal(place(servers(10, 0), undefined, { allowSpan: true, exclude: new Set([2]) }), 1);
  assert.equal(place(servers(10), undefined, { allowSpan: true, exclude: new Set([1]) }), null);
});

test("overloaded lists servers above the hard limit", () => {
  assert.deepEqual(
    overloaded(servers(95, 50, 91)).map((s) => s.id),
    [1, 3],
  );
});
