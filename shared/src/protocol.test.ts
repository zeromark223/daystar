import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  quantize,
  assembleSnapshot,
  snapshotEntry,
  snapshotTail,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.ts";

const player = { id: 7, name: "Mochi", appearance: 5, x: 540.5, y: 600.25, dir: "west" as const, moving: true, role: "speaker" as const, hand: 0 };

test("client messages round-trip", () => {
  const messages: ClientMessage[] = [
    { t: "join", name: "Mochi 🌟", appearance: 23, hostKey: "" },
    { t: "join", name: "Host", appearance: 0, hostKey: "k3y" },
    { t: "chat", text: "Xin chào mọi người" },
    { t: "move", x: 123.25, y: 9876.75, dir: "north", moving: false },
    { t: "set_role", id: 9, role: "speaker" },
    { t: "set_role", id: 9, role: "guest" },
    { t: "voice", seq: 65535, data: new Uint8Array([1, 2, 3]) },
    { t: "react", kind: 5 },
    { t: "hand", id: 9, up: true },
    { t: "hand", id: 9, up: false },
    { t: "poll_start", question: "Lunch?", options: ["Phở", "Bún chả", "Cơm tấm"] },
    { t: "poll_end" },
    { t: "who", ids: [1, 300, 65535] },
    { t: "gather" },
    { t: "release" },
  ];
  for (const m of messages) assert.deepEqual(decodeClientMessage(encodeClientMessage(m)), m);
});

const emptyTail = { time: 4_294_967_295, voice: [], joined: [], left: [], reactions: [], hands: [], pollCounts: [], slots: [] };
const orbit = { start: 4_294_967_000, now: 300, slots: [{ id: 7, slot: 0 }, { id: 8, slot: 65535 }] };
const poll = { id: 4_000_000_001, question: "Which planet next?", options: ["Mars 🔴", "Venus", "Neptune"], open: true, counts: [0, 2, 1] };

test("server messages round-trip", () => {
  const chat = { id: 3, playerId: 7, name: "Mochi", text: "hi", ts: 1_790_219_348_670 };
  const messages: ServerMessage[] = [
    { t: "welcome", selfId: 7, players: [player, { ...player, id: 8, hand: 17_900_000_000 % 2 ** 32 }], chat: [chat], snapshotHz: 20, poll: null, orbit: null },
    { t: "welcome", selfId: 7, players: [], chat: [], snapshotHz: 10, poll, orbit },
    { t: "player_joined", player },
    { t: "player_left", id: 7 },
    { t: "chat", message: chat },
    { t: "correction", x: 10, y: 20.5 },
    { t: "error", message: "nope" },
    { t: "snapshot", players: [{ id: 1, x: 9999.75, y: 0, dir: "south", moving: true, age: 255 }], ...emptyTail },
    {
      t: "snapshot",
      time: 0,
      players: [],
      voice: [{ id: 2, seq: 4, data: new Uint8Array([9, 8]) }],
      joined: [player],
      left: [3, 65535],
      reactions: [{ id: 7, kind: 0 }, { id: 8, kind: 5 }],
      hands: [{ id: 7, hand: 4_000_000_000 }, { id: 8, hand: 0 }],
      pollCounts: [3, 0, 65535],
      slots: [{ id: 9, slot: 12 }],
    },
    { t: "migrate" },
    { t: "role", id: 7, role: "host" },
    { t: "rate", snapshotHz: 10 },
    { t: "view", from: 300, to: 301, players: [{ id: 3, x: 1200.5, y: 4000, dir: "north", moving: false }] },
    { t: "poll", poll },
    { t: "poll", poll: { ...poll, open: false, counts: [12, 30, 0] } },
    { t: "players", players: [player], missing: [4, 5] },
    { t: "orbit", active: true, ...orbit },
    { t: "orbit", active: false, start: 1, now: 2, slots: [] },
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

test("snapshot costs 8 bytes per player", () => {
  const players = Array.from({ length: 100 }, (_, i) => ({ id: i, x: i, y: i, dir: "south" as const, moving: false, age: i }));
  // + 4 (time) + 1 (no voice) + 2 (no joins) + 2 (no leaves) + 2 (no reactions) + 2 (no hands)
  // + 1 (no poll counts) + 2 (no seats)
  assert.equal(encodeServerMessage({ t: "snapshot", players, ...emptyTail }).length, 1 + 2 + 100 * 8 + 16);
});

test("malformed or unknown frames decode to null", () => {
  assert.equal(decodeClientMessage(new Uint8Array([])), null);
  assert.equal(decodeClientMessage(new Uint8Array([99, 1, 2])), null);
  const move = encodeClientMessage({ t: "move", x: 1, y: 2, dir: "south", moving: false });
  assert.equal(decodeClientMessage(move.subarray(0, move.length - 1)), null);
  // Unknown appearance index.
  assert.equal(decodeClientMessage(new Uint8Array([1, 1, 0, 65, 200, 0, 0])), null);
  // A client cannot ask for the host role.
  assert.equal(decodeClientMessage(new Uint8Array([4, 1, 0, 2])), null);
  // Server-only opcode sent by a client.
  assert.equal(decodeClientMessage(encodeServerMessage({ t: "player_left", id: 1 })), null);
});

test("snapshots assembled from parts match the regular encoder", () => {
  const players = Array.from({ length: 300 }, (_, i) => ({
    id: i * 7,
    x: Math.random() * 10000,
    y: Math.random() * 10000,
    dir: (["north", "south", "east", "west"] as const)[i % 4],
    moving: i % 3 === 0,
    age: (i * 37) % 256,
  }));
  const voice = [{ id: 3, seq: 9, data: new Uint8Array([1, 2, 3]) }];
  for (const v of [[], voice]) {
    for (const joined of [[], [player]]) {
      const left = joined.length ? [9, 10] : [];
      const extras = joined.length
        ? { reactions: [{ id: 3, kind: 1 }], hands: [{ id: 7, hand: 99 }], pollCounts: [4, 5], slots: [{ id: 3, slot: 9 }] }
        : { reactions: [], hands: [], pollCounts: [], slots: [] };
      const tail = { time: 123_456_789, voice: v, joined, left, ...extras };
      const regular = encodeServerMessage({ t: "snapshot", players, ...tail });
      const parts = assembleSnapshot(players.map((p) => snapshotEntry(p, p.age)), snapshotTail(tail));
      assert.deepEqual([...parts], [...regular]);
    }
  }
});
