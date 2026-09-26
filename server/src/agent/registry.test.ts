import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry } from "./registry.ts";

const info = (server: number, capacity = 100) => ({
  server,
  capacity,
  publicUrl: `ws://s${server}/ws`,
  meshUrl: `ws://s${server}/mesh`,
});

function cluster(n: number, now = 0) {
  const reg = new Registry();
  for (let i = 1; i <= n; i++) reg.register(info(i), [], now);
  return reg;
}

test("players of one room get distinct ids and stay on the room's server", () => {
  const reg = cluster(2);
  const a = reg.seat("r1", { reservedUntil: 30_000, allowSpan: false }, 0)!;
  const b = reg.seat("r1", { reservedUntil: 30_000, allowSpan: false }, 0)!;
  assert.notEqual(a.player, b.player);
  assert.equal(a.server.server, b.server.server);
});

test("different rooms spread over servers by load", () => {
  const reg = cluster(2);
  const first = reg.seat("r1", { reservedUntil: 30_000, allowSpan: false }, 0)!;
  const second = reg.seat("r2", { reservedUntil: 30_000, allowSpan: false }, 0)!;
  assert.notEqual(first.server.server, second.server.server);
});

test("unused tickets expire and their ids cool down before reuse", () => {
  const reg = cluster(1);
  const a = reg.seat("r1", { reservedUntil: 1000, allowSpan: false }, 0)!;
  reg.sweep(2000);
  assert.equal(reg.seatOf("r1", a.player), undefined);
  const b = reg.seat("r1", { reservedUntil: 40_000, allowSpan: false }, 2000)!;
  assert.notEqual(b.player, a.player);
});

test("joined seats survive the sweep; left frees them", () => {
  const reg = cluster(1);
  const a = reg.seat("r1", { reservedUntil: 1000, allowSpan: false }, 0)!;
  reg.joined(1, "r1", a.player);
  reg.sweep(2000);
  assert.equal(reg.seatOf("r1", a.player), 1);
  reg.left(1, "r1", a.player, 2000);
  assert.equal(reg.seatOf("r1", a.player), undefined);
});

test("a silent server is declared lost and its players are dropped", () => {
  const reg = cluster(2, 0);
  const a = reg.seat("r1", { reservedUntil: 30_000, allowSpan: false }, 0)!;
  reg.joined(a.server.server, "r1", a.player);
  const other = a.server.server === 1 ? 2 : 1;
  reg.stats(other, {} as never, 4000);
  assert.deepEqual(reg.sweep(4000), [a.server.server]);
  assert.equal(reg.seatOf("r1", a.player), undefined);
  // The room now lives on the survivor.
  assert.equal(reg.seat("r1", { reservedUntil: 40_000, allowSpan: false }, 4000)!.server.server, other);
});

test("re-registering replaces the server's players with its own list", () => {
  const reg = cluster(1);
  reg.joined(1, "r1", 5);
  reg.register(info(1), [{ room: "r1", player: 9 }]);
  assert.equal(reg.seatOf("r1", 5), undefined);
  assert.equal(reg.seatOf("r1", 9), 1);
});

test("load counts connected and reserved seats", () => {
  const reg = cluster(1);
  reg.seat("r1", { reservedUntil: 30_000, allowSpan: false }, 0);
  reg.joined(1, "r2", 1);
  assert.equal(reg.views()[0].players, 2);
});
