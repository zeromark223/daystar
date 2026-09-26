import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMesh, encodeMesh, type MeshMessage } from "./mesh-protocol.ts";

const player = { id: 9, name: "Zed 🦌", character: "wolf_black" as const, x: 540.5, y: 600.25, dir: "west" as const, moving: true };

test("every mesh message round-trips", () => {
  const messages: MeshMessage[] = [
    { t: "interest", room: "cozy-den-1", on: true },
    { t: "interest", room: "cozy-den-1", on: false },
    { t: "room_state", room: "r", players: [player, { ...player, id: 10 }] },
    { t: "room_state", room: "r", players: [] },
    { t: "joined", room: "r", player },
    { t: "left", room: "r", id: 9 },
    { t: "moves", room: "r", players: [{ id: 9, x: 1, y: 2.5, dir: "north", moving: false }] },
    { t: "chat", room: "r", message: { id: 2 * 0x1000000 + 5, playerId: 9, name: "Zed", text: "xin chào", ts: 1_790_000_000_000 } },
    { t: "takeover", room: "r", id: 9 },
    { t: "handoff", room: "r", id: 9, player },
    { t: "handoff", room: "r", id: 9, player: null },
  ];
  for (const m of messages) assert.deepEqual(decodeMesh(encodeMesh(m)), m);
});

test("garbage decodes to null", () => {
  assert.equal(decodeMesh(new Uint8Array([])), null);
  assert.equal(decodeMesh(new Uint8Array([1, 2, 3])), null);
  const ok = encodeMesh({ t: "left", room: "r", id: 1 });
  assert.equal(decodeMesh(ok.subarray(0, ok.length - 1)), null);
});
