import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOM_ID_PATTERN } from "../../shared/src/constants.ts";
import { createRoom, hostKeyFor, isHostKey, newRoomId } from "./host-key.ts";

test("room ids are valid and distinct", () => {
  const ids = new Set(Array.from({ length: 200 }, newRoomId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, ROOM_ID_PATTERN);
});

test("a host key only opens its own room, with its own secret", () => {
  const key = hostKeyFor("golden-comet-abc", "s1");
  assert.ok(isHostKey("golden-comet-abc", key, "s1"));
  assert.ok(!isHostKey("golden-comet-abd", key, "s1"));
  assert.ok(!isHostKey("golden-comet-abc", key, "s2"));
  assert.ok(!isHostKey("golden-comet-abc", "", "s1"));
  assert.ok(!isHostKey("golden-comet-abc", key.slice(1), "s1"));
});

test("POST /api/rooms returns a room and its key", async () => {
  const res = createRoom(new Request("http://x/api/rooms", { method: "POST" }), "s1");
  const { room, hostKey } = (await res.json()) as { room: string; hostKey: string };
  assert.ok(isHostKey(room, hostKey, "s1"));
  assert.equal(createRoom(new Request("http://x/api/rooms"), "s1").status, 405);
});
