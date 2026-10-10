import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMesh, encodeMesh, type MeshMessage } from "./mesh-protocol.ts";

const player = { id: 9, name: "Zed 🦌", appearance: 12, x: 540.5, y: 600.25, dir: "west" as const, moving: true, role: "guest" as const, hand: 0 };

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
    { t: "role", room: "r", id: 9, role: "speaker" },
    { t: "set_role", room: "r", id: 9, role: "guest" },
    { t: "voice", room: "r", frames: [{ id: 9, seq: 3, data: new Uint8Array([1, 2]) }] },
    { t: "reactions", room: "r", list: [{ id: 9, kind: 2 }] },
    { t: "hand", room: "r", id: 9, hand: 179_000_000 },
    { t: "set_hand", room: "r", id: 9, hand: 0 },
    { t: "poll", room: "r", poll: { id: 7, question: "Q?", options: ["a", "b"], open: false, counts: [1, 2] } },
    { t: "orbit", room: "r", orbit: { active: true, start: 1_791_000_000_123, slots: [{ id: 9, slot: 0 }] } },
    { t: "orbit", room: "r", orbit: { active: false, at: 1_791_000_060_456, seed: 77 } },
    { t: "slots", room: "r", list: [{ id: 9, slot: 65535 }] },
  ];
  for (const m of messages) assert.deepEqual(decodeMesh(encodeMesh(m)), m);
});

test("garbage decodes to null", () => {
  assert.equal(decodeMesh(new Uint8Array([])), null);
  assert.equal(decodeMesh(new Uint8Array([1, 2, 3])), null);
  const ok = encodeMesh({ t: "left", room: "r", id: 1 });
  assert.equal(decodeMesh(ok.subarray(0, ok.length - 1)), null);
});
