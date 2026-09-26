import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  quantize,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.ts";

const player = { id: 7, name: "Mochi", appearance: 5, x: 540.5, y: 600.25, dir: "west" as const, moving: true };

test("client messages round-trip", () => {
  const messages: ClientMessage[] = [
    { t: "join", name: "Mochi 🌟", appearance: 23 },
    { t: "chat", text: "Xin chào mọi người" },
    { t: "move", x: 123.25, y: 9876.75, dir: "north", moving: false },
  ];
  for (const m of messages) assert.deepEqual(decodeClientMessage(encodeClientMessage(m)), m);
});

test("server messages round-trip", () => {
  const chat = { id: 3, playerId: 7, name: "Mochi", text: "hi", ts: 1_790_219_348_670 };
  const messages: ServerMessage[] = [
    { t: "welcome", selfId: 7, players: [player], chat: [chat] },
    { t: "player_joined", player },
    { t: "player_left", id: 7 },
    { t: "chat", message: chat },
    { t: "correction", x: 10, y: 20.5 },
    { t: "error", message: "nope" },
    { t: "snapshot", players: [{ id: 1, x: 9999.75, y: 0, dir: "south", moving: true }] },
    { t: "migrate" },
  ];
  for (const m of messages) assert.deepEqual(decodeServerMessage(encodeServerMessage(m)), m);
});

test("positions are quantized to the wire grid", () => {
  const sent = { t: "move" as const, x: 100.1, y: 200.9, dir: "east" as const, moving: true };
  const got = decodeClientMessage(encodeClientMessage(sent));
  assert.deepEqual(got, { ...sent, x: quantize(100.1), y: quantize(200.9) });
  assert.equal(quantize(100.1), 100);
  assert.equal(quantize(200.9), 201);
});

test("snapshot costs 7 bytes per player", () => {
  const players = Array.from({ length: 100 }, (_, i) => ({ id: i, x: i, y: i, dir: "south" as const, moving: false }));
  assert.equal(encodeServerMessage({ t: "snapshot", players }).length, 1 + 2 + 100 * 7);
});

test("malformed or unknown frames decode to null", () => {
  assert.equal(decodeClientMessage(new Uint8Array([])), null);
  assert.equal(decodeClientMessage(new Uint8Array([99, 1, 2])), null);
  const move = encodeClientMessage({ t: "move", x: 1, y: 2, dir: "south", moving: false });
  assert.equal(decodeClientMessage(move.subarray(0, move.length - 1)), null);
  // Unknown appearance index.
  assert.equal(decodeClientMessage(new Uint8Array([1, 1, 0, 65, 200])), null);
  // Server-only opcode sent by a client.
  assert.equal(decodeClientMessage(encodeServerMessage({ t: "player_left", id: 1 })), null);
});
