import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CollisionMap } from "../../shared/src/collision.ts";
import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../shared/src/protocol.ts";
import { Room, type PeerEvents } from "./room.ts";

const map = CollisionMap.parse(
  readFileSync(new URL("../../client/public/assets/collision.txt", import.meta.url), "utf8"),
);

/** Stand-in peer: records what the room sends and feeds it client messages. */
class FakeSocket {
  received: ServerMessage[] = [];
  events!: PeerEvents;
  subscribed = false;
  subscribe(): void {
    this.subscribed = true;
  }
  send(data: Uint8Array): void {
    this.received.push(decodeServerMessage(data)!);
  }
  close(): void {
    this.events.close();
  }
  deliver(msg: ClientMessage): void {
    this.events.message(encodeClientMessage(msg));
  }
  take(): ServerMessage[] {
    const out = this.received;
    this.received = [];
    return out;
  }
}

/** Fake Bun topic: fans a frame out to every subscribed socket, counting calls. */
function fakeTopic() {
  const sockets: FakeSocket[] = [];
  const topic = {
    publishes: 0,
    sockets,
    publish: (data: Uint8Array) => {
      topic.publishes++;
      for (const s of sockets) if (s.subscribed) s.send(data);
    },
  };
  return topic;
}

function setup(topic?: ReturnType<typeof fakeTopic>) {
  const room = new Room("test", { map, onEmpty: () => {}, publish: topic?.publish ?? null });
  const tick = () => (room as unknown as { tick(): void }).tick();
  const sockets = ["Ann", "Ben", "Cat"].map((name) => {
    const s = new FakeSocket();
    topic?.sockets.push(s);
    s.events = room.accept(s);
    s.deliver({ t: "join", name, character: "rabbit_white" });
    return s;
  });
  const welcome = sockets[0].received.find((m) => m.t === "welcome")!;
  const self = welcome.t === "welcome" ? welcome.players.find((p) => p.id === welcome.selfId)! : null!;
  for (const s of sockets) s.take();
  const done = () => sockets.forEach((s) => s.close());
  return { room, tick, sockets, self, done };
}

test("snapshots carry only players that moved", () => {
  const { tick, sockets, self, done } = setup();
  sockets[0].deliver({ t: "move", x: self.x + 1, y: self.y, dir: "east", moving: true });
  tick();
  for (const s of sockets) {
    const snaps = s.take().filter((m) => m.t === "snapshot");
    assert.equal(snaps.length, 1);
    assert.deepEqual(
      snaps[0].t === "snapshot" && snaps[0].players.map((p) => p.id),
      [self.id],
    );
  }
  done();
});

test("no snapshot is sent while everyone is idle", () => {
  const { tick, sockets, self, done } = setup();
  sockets[0].deliver({ t: "move", x: self.x + 1, y: self.y, dir: "east", moving: true });
  tick();
  for (const s of sockets) s.take();
  tick();
  tick();
  for (const s of sockets) assert.deepEqual(s.take(), []);
  done();
});

test("a player who stops is sent once more with moving=false", () => {
  const { tick, sockets, self, done } = setup();
  sockets[0].deliver({ t: "move", x: self.x + 1, y: self.y, dir: "east", moving: true });
  tick();
  sockets[0].deliver({ t: "move", x: self.x + 1, y: self.y, dir: "east", moving: false });
  tick();
  const last = sockets[1].take().filter((m) => m.t === "snapshot").at(-1);
  assert.ok(last?.t === "snapshot" && last.players.length === 1 && last.players[0].moving === false);
  done();
});

test("with publish, broadcasts go out once per frame to joined players only", () => {
  const topic = fakeTopic();
  const { tick, sockets, self, done } = setup(topic);
  assert.ok(sockets.every((s) => s.subscribed));
  const before = topic.publishes;
  sockets[0].deliver({ t: "move", x: self.x + 1, y: self.y, dir: "east", moving: true });
  tick();
  assert.equal(topic.publishes, before + 1);
  for (const s of sockets) assert.equal(s.take().filter((m) => m.t === "snapshot").length, 1);
  done();
});

test("with publish, a newcomer gets welcome but not its own join", () => {
  const topic = fakeTopic();
  const { room, sockets, done } = setup(topic);
  const late = new FakeSocket();
  topic.sockets.push(late);
  late.events = room.accept(late);
  late.deliver({ t: "join", name: "Dan", character: "deer" });
  assert.deepEqual(
    late.take().map((m) => m.t),
    ["welcome"],
  );
  for (const s of sockets) assert.deepEqual(s.take().map((m) => m.t), ["player_joined"]);
  late.close();
  done();
});

// ------------------------------------------------------------ cluster sync

const byNumber = (a: number, b: number) => a - b;

function syncedRoom() {
  const sent = { joined: [] as number[], left: [] as number[], moves: [] as number[][], chat: [] as string[] };
  const room = new Room("sync", {
    map,
    onEmpty: () => {},
    sync: {
      joined: (p) => sent.joined.push(p.id),
      left: (id) => sent.left.push(id),
      moves: (players) => sent.moves.push(players.map((p) => p.id)),
      chat: (m) => sent.chat.push(m.text),
    },
  });
  const tick = () => (room as unknown as { tick(): void }).tick();
  const local = new FakeSocket();
  local.events = room.accept(local, 7);
  local.deliver({ t: "join", name: "Ann", character: "rabbit_white" });
  const welcome = local.take().find((m) => m.t === "welcome")!;
  const self = welcome.t === "welcome" ? welcome.players.find((p) => p.id === 7)! : null!;
  return { room, tick, local, self, sent };
}

const remoteInfo = { id: 42, name: "Zed", character: "deer" as const, x: 540, y: 600, dir: "south" as const, moving: false };

test("local joins, moves, chat and leaves are mirrored; remote ones are not echoed", () => {
  const { room, tick, local, self, sent } = syncedRoom();
  assert.deepEqual(sent.joined, [7]);
  room.remoteJoined(2, remoteInfo);
  local.deliver({ t: "move", x: self.x + 1, y: self.y, dir: "east", moving: true });
  room.remoteMoves(2, [{ id: 42, x: 541, y: 600, dir: "east", moving: true }]);
  tick();
  // Both changes reach our client, but only our own player is mirrored.
  const snap = local.take().filter((m) => m.t === "snapshot").at(-1);
  assert.deepEqual(snap?.t === "snapshot" && snap.players.map((p) => p.id).sort(byNumber), [7, 42]);
  assert.deepEqual(sent.moves, [[7]]);
  local.deliver({ t: "chat", text: "hi" });
  room.remoteChat({ id: 1, playerId: 42, name: "Zed", text: "yo", ts: 0 });
  assert.deepEqual(sent.chat, ["hi"]);
  local.close();
  assert.deepEqual(sent.left, [7]);
});

test("remote players appear, move, leave, and vanish with their server", () => {
  const { room, local, tick } = syncedRoom();
  room.remoteJoined(2, remoteInfo);
  room.remoteJoined(3, { ...remoteInfo, id: 43 });
  assert.deepEqual(
    local.take().map((m) => m.t),
    ["player_joined", "player_joined"],
  );
  // Only the owning server can move or remove a replica.
  room.remoteMoves(3, [{ id: 42, x: 900, y: 900, dir: "north", moving: true }]);
  room.remoteLeft(3, 42);
  tick();
  assert.deepEqual(local.take(), []);
  room.dropOwner(2);
  room.dropOwner(3);
  assert.deepEqual(
    local.take().map((m) => (m.t === "player_left" ? m.id : m.t)),
    [42, 43],
  );
  assert.equal(room.playerCount, 1);
});

test("a newcomer's welcome lists replicas, and full state for a peer lists only locals", () => {
  const { room } = syncedRoom();
  room.remoteJoined(2, remoteInfo);
  const late = new FakeSocket();
  late.events = room.accept(late, 8);
  late.deliver({ t: "join", name: "Bo", character: "deer" });
  const welcome = late.take().find((m) => m.t === "welcome");
  assert.deepEqual(welcome?.t === "welcome" && welcome.players.map((p) => p.id).sort(byNumber), [7, 8, 42]);
  assert.deepEqual(room.localState().map((p) => p.id).sort(byNumber), [7, 8]);
  assert.deepEqual(room.playerIds().sort(byNumber), [7, 8]);
});

test("a repeated remote join refreshes state instead of announcing twice", () => {
  const { room, local } = syncedRoom();
  room.remoteJoined(2, remoteInfo);
  room.remoteJoined(2, { ...remoteInfo, x: 700 });
  assert.deepEqual(
    local.take().map((m) => m.t),
    ["player_joined"],
  );
});
