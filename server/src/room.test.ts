import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../shared/src/protocol.ts";
import { Room, type PeerEvents } from "./room.ts";


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
  const room = new Room("test", { onEmpty: () => {}, publish: topic?.publish ?? null });
  const tick = () => (room as unknown as { tick(): void }).tick();
  const sockets = ["Ann", "Ben", "Cat"].map((name) => {
    const s = new FakeSocket();
    topic?.sockets.push(s);
    s.events = room.accept(s);
    s.deliver({ t: "join", name, appearance: 0 });
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
  late.deliver({ t: "join", name: "Dan", appearance: 9 });
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
  local.deliver({ t: "join", name: "Ann", appearance: 0 });
  const welcome = local.take().find((m) => m.t === "welcome")!;
  const self = welcome.t === "welcome" ? welcome.players.find((p) => p.id === 7)! : null!;
  return { room, tick, local, self, sent };
}

const remoteInfo = { id: 42, name: "Zed", appearance: 9, x: 6200, y: 5000, dir: "south" as const, moving: false };

test("local joins, moves, chat and leaves are mirrored; remote ones are not echoed", () => {
  const { room, tick, local, self, sent } = syncedRoom();
  assert.deepEqual(sent.joined, [7]);
  room.remoteJoined(2, remoteInfo);
  local.deliver({ t: "move", x: self.x + 1, y: self.y, dir: "east", moving: true });
  room.remoteMoves(2, [{ id: 42, x: 6201, y: 5000, dir: "east", moving: true }]);
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
  room.remoteMoves(3, [{ id: 42, x: 6400, y: 5000, dir: "north", moving: true }]);
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
  late.deliver({ t: "join", name: "Bo", appearance: 9 });
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

// ------------------------------------------------------------ migration

test("pickMigrants asks random local players once and never replicas", () => {
  const { room, sockets, done } = setup();
  room.remoteJoined(2, remoteInfo);
  const picked = room.pickMigrants(2);
  assert.equal(picked.length, 2);
  assert.ok(!picked.includes(42));
  const asked = sockets.filter((s) => s.take().some((m) => m.t === "migrate")).length;
  assert.equal(asked, 2);
  // The two already asked are not picked again; only one local player is left.
  assert.equal(room.pickMigrants(5).length, 1);
  done();
});

test("handOff turns a local player into a replica silently; its old socket is ignored", () => {
  const { room, tick, sockets, self, done } = setup();
  const [leaving, other] = sockets;
  const info = room.handOff(self.id, 2);
  assert.equal(info?.id, self.id);
  assert.equal(room.playerCount, 2);
  // The old socket keeps talking and then closes: nobody hears about it.
  leaving.deliver({ t: "move", x: self.x + 1, y: self.y, dir: "east", moving: true });
  tick();
  leaving.close();
  assert.deepEqual(other.take(), []);
  // Moves now come from the new owner.
  room.remoteMoves(2, [{ id: self.id, x: 6000, y: 6000, dir: "west", moving: true }]);
  tick();
  assert.ok(other.take().some((m) => m.t === "snapshot"));
  assert.equal(room.handOff(self.id, 3), null);
  done();
});

test("a migrating player joins where it was, without a second join announcement", async () => {
  const { room, sockets, done } = setup();
  room.remoteJoined(2, remoteInfo);
  for (const s of sockets) s.take(); // the replica's own (legitimate) join
  const moved = new FakeSocket();
  const resume = Promise.resolve({ ...remoteInfo, x: 6300, y: 5100, dir: "west" as const });
  moved.events = room.accept(moved, 42, resume);
  moved.deliver({ t: "join", name: "Zed", appearance: 9 });
  await resume;
  await Promise.resolve();
  const welcome = moved.take().find((m) => m.t === "welcome");
  const me = welcome?.t === "welcome" ? welcome.players.find((p) => p.id === 42) : undefined;
  assert.deepEqual(me && [me.x, me.y, me.dir], [6300, 5100, "west"]);
  for (const s of sockets) assert.ok(!s.take().some((m) => m.t === "player_joined"));
  assert.equal(room.playerCount, 4);
  moved.close();
  done();
});
