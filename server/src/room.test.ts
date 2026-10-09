import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeServerMessage,
  encodeClientMessage,
  quantize,
  type ClientMessage,
  type ServerMessage,
} from "../../shared/src/protocol.ts";
import { POLL_COUNT_MS, pollZones } from "../../shared/src/poll.ts";
import { orbitPosition, STAGE_SLOTS } from "../../shared/src/orbit.ts";
import { Room, type PeerEvents } from "./room.ts";


/** Stand-in peer: records what the room sends and feeds it client messages. */
class FakeSocket {
  received: ServerMessage[] = [];
  /** Like Bun past its backpressure limit: frames to this socket are silently dropped. */
  dropping = false;
  events!: PeerEvents;
  readonly channels = new Set<string>();
  get subscribed(): boolean {
    return this.channels.size > 0;
  }
  subscribe(channel: string): void {
    this.channels.add(channel);
  }
  unsubscribe(channel: string): void {
    this.channels.delete(channel);
  }
  send(data: Uint8Array): void {
    if (this.dropping) return;
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

const byNumber = (a: number, b: number) => a - b;

/** RoomSync members a test does not watch. */
const quietSync = {
  joined() {},
  left() {},
  moves() {},
  chat() {},
  role() {},
  setRole() {},
  voice() {},
  reactions() {},
  hand() {},
  setHand() {},
  poll() {},
  orbit() {},
  slots() {},
};

/** Ids that joined / left, as carried by snapshots. */
const joinedIn = (msgs: ServerMessage[]) => msgs.flatMap((m) => (m.t === "snapshot" ? m.joined.map((p) => p.id) : []));
const leftIn = (msgs: ServerMessage[]) => msgs.flatMap((m) => (m.t === "snapshot" ? m.left : []));

/** Fake Bun topics: fans a frame out to every socket subscribed to the channel, counting calls. */
function fakeTopic() {
  const sockets: { channels: Set<string>; send(data: Uint8Array): void }[] = [];
  const topic = {
    publishes: 0,
    sockets,
    publish: (channel: string, data: Uint8Array) => {
      topic.publishes++;
      for (const s of sockets) if (s.channels.has(channel)) s.send(data);
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
    s.deliver({ t: "join", name, appearance: 0, hostKey: "" });
    return s;
  });
  const welcome = sockets[0].received.find((m) => m.t === "welcome")!;
  const self = welcome.t === "welcome" ? welcome.players.find((p) => p.id === welcome.selfId)! : null!;
  tick(); // drain the joins, which ride the next snapshot
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

test("with publish, broadcasts go out once per channel to joined players only", () => {
  const topic = fakeTopic();
  const { tick, sockets, self, done } = setup(topic);
  // Everyone gets room events plus the snapshots of its map cell and group.
  assert.ok(sockets.every((s) => s.channels.has("") && s.channels.size === 2));
  const before = topic.publishes;
  sockets[0].deliver({ t: "move", x: self.x + 1, y: self.y, dir: "east", moving: true });
  tick();
  // At most one publish per (cell, group) channel in use, and every player gets the move once.
  const inUse = new Set(sockets.flatMap((s) => [...s.channels].filter((c) => c !== ""))).size;
  assert.ok(topic.publishes - before <= inUse);
  for (const s of sockets) assert.equal(s.take().filter((m) => m.t === "snapshot").length, 1);
  done();
});

test("with publish, a newcomer gets welcome now and everyone sees the join in the next snapshot", () => {
  const topic = fakeTopic();
  const { room, tick, sockets, done } = setup(topic);
  const late = new FakeSocket();
  topic.sockets.push(late);
  late.events = room.accept(late);
  late.deliver({ t: "join", name: "Dan", appearance: 9, hostKey: "" });
  const welcome = late.take();
  assert.deepEqual(welcome.map((m) => m.t), ["welcome"]);
  const id = welcome[0].t === "welcome" ? welcome[0].selfId : -1;
  for (const s of sockets) assert.deepEqual(s.take(), []);
  tick();
  // The newcomer hears its own join too; clients skip ids they already know.
  for (const s of [...sockets, late]) assert.deepEqual(joinedIn(s.take()), [id]);
  late.close();
  done();
});

test("joins and leaves in one tick share a frame; a join and leave within it cancel", () => {
  const { room, tick, sockets, done } = setup();
  const [ann] = sockets;
  const join = (name: string) => {
    const s = new FakeSocket();
    s.events = room.accept(s);
    s.deliver({ t: "join", name, appearance: 0, hostKey: "" });
    const w = s.take()[0];
    return { s, id: w.t === "welcome" ? w.selfId : -1 };
  };
  const dan = join("Dan");
  const eve = join("Eve");
  const fay = join("Fay");
  fay.s.close();
  sockets[2].close();
  tick();
  const got = ann.take();
  assert.equal(got.length, 1);
  assert.deepEqual(joinedIn(got).sort(byNumber), [dan.id, eve.id].sort(byNumber));
  assert.equal(leftIn(got).length, 1);
  dan.s.close();
  eve.s.close();
  tick();
  assert.deepEqual(leftIn(ann.take()).sort(byNumber), [dan.id, eve.id].sort(byNumber));
  sockets.slice(0, 2).forEach((s) => s.close());
});

// ------------------------------------------------------------ cluster sync

function syncedRoom() {
  const sent = { joined: [] as number[], left: [] as number[], moves: [] as number[][], chat: [] as string[] };
  const room = new Room("sync", {
    onEmpty: () => {},
    sync: {
      ...quietSync,
      joined: (p) => sent.joined.push(p.id),
      left: (id) => sent.left.push(id),
      moves: (players) => sent.moves.push(players.map((p) => p.id)),
      chat: (m) => sent.chat.push(m.text),
      role: () => {},
      setRole: () => {},
      voice: () => {},
    },
  });
  const tick = () => (room as unknown as { tick(): void }).tick();
  const local = new FakeSocket();
  local.events = room.accept(local, 7);
  local.deliver({ t: "join", name: "Ann", appearance: 0, hostKey: "" });
  tick(); // our own join rides the next snapshot
  const welcome = local.take().find((m) => m.t === "welcome")!;
  const self = welcome.t === "welcome" ? welcome.players.find((p) => p.id === 7)! : null!;
  return { room, tick, local, self, sent };
}

const remoteInfo = {
  id: 42,
  name: "Zed",
  appearance: 9,
  x: 6200,
  y: 5000,
  dir: "south" as const,
  moving: false,
  role: "guest" as const,
  hand: 0,
};

test("local joins, moves, chat and leaves are mirrored; remote ones are not echoed", () => {
  const { room, tick, local, self, sent } = syncedRoom();
  assert.deepEqual(sent.joined, [7]);
  // Close enough to be in view (area of interest).
  room.remoteJoined(2, { ...remoteInfo, x: self.x + 100, y: self.y });
  local.deliver({ t: "move", x: self.x + 1, y: self.y, dir: "east", moving: true });
  room.remoteMoves(2, [{ id: 42, x: self.x + 101, y: self.y, dir: "east", moving: true }]);
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
  tick();
  assert.deepEqual(joinedIn(local.take()), [42, 43]);
  // Only the owning server can move or remove a replica.
  room.remoteMoves(3, [{ id: 42, x: 6400, y: 5000, dir: "north", moving: true }]);
  room.remoteLeft(3, 42);
  tick();
  assert.deepEqual(local.take(), []);
  room.dropOwner(2);
  room.dropOwner(3);
  tick();
  assert.deepEqual(leftIn(local.take()), [42, 43]);
  assert.equal(room.playerCount, 1);
});

test("a newcomer's welcome lists replicas, and full state for a peer lists only locals", () => {
  const { room } = syncedRoom();
  room.remoteJoined(2, remoteInfo);
  const late = new FakeSocket();
  late.events = room.accept(late, 8);
  late.deliver({ t: "join", name: "Bo", appearance: 9, hostKey: "" });
  const welcome = late.take().find((m) => m.t === "welcome");
  assert.deepEqual(welcome?.t === "welcome" && welcome.players.map((p) => p.id).sort(byNumber), [7, 8, 42]);
  assert.deepEqual(room.localState().map((p) => p.id).sort(byNumber), [7, 8]);
  assert.deepEqual(room.playerIds().sort(byNumber), [7, 8]);
});

test("a repeated remote join refreshes state instead of announcing twice", () => {
  const { room, tick, local } = syncedRoom();
  room.remoteJoined(2, remoteInfo);
  room.remoteJoined(2, { ...remoteInfo, x: 700 });
  tick();
  assert.deepEqual(joinedIn(local.take()), [42]);
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
  // Moves now come from the new owner (nearby, so the other player sees them).
  room.remoteMoves(2, [{ id: self.id, x: self.x + 10, y: self.y, dir: "west", moving: true }]);
  tick();
  assert.ok(other.take().some((m) => m.t === "snapshot"));
  assert.equal(room.handOff(self.id, 3), null);
  done();
});

test("a migrating player joins where it was, without a second join announcement", async () => {
  const { room, tick, sockets, done } = setup();
  room.remoteJoined(2, remoteInfo);
  tick();
  for (const s of sockets) s.take(); // the replica's own (legitimate) join
  const moved = new FakeSocket();
  const resume = Promise.resolve({ ...remoteInfo, x: 6300, y: 5100, dir: "west" as const });
  moved.events = room.accept(moved, 42, resume);
  moved.deliver({ t: "join", name: "Zed", appearance: 9, hostKey: "" });
  await resume;
  await Promise.resolve();
  const welcome = moved.take().find((m) => m.t === "welcome");
  const me = welcome?.t === "welcome" ? welcome.players.find((p) => p.id === 42) : undefined;
  assert.deepEqual(me && [me.x, me.y, me.dir], [6300, 5100, "west"]);
  tick();
  for (const s of sockets) assert.deepEqual(joinedIn(s.take()), []);
  assert.equal(room.playerCount, 4);
  moved.close();
  done();
});

// ------------------------------------------------------------ roles and voice

const HOST_KEY = "secret-key";

function hostedRoom(opts: { sync?: ConstructorParameters<typeof Room>[1]["sync"] } = {}) {
  const room = new Room("hosted", { onEmpty: () => {}, isHostKey: (k) => k === HOST_KEY, sync: opts.sync });
  /** Run a tick `later` ms from now (idle-room voice waits VOICE_FLUSH_MS). */
  const tick = (later = 0) => (room as unknown as { tick(now: number): void }).tick(Date.now() + later);
  const join = (name: string, hostKey = "", id?: number) => {
    const s = new FakeSocket();
    s.events = room.accept(s, id);
    s.deliver({ t: "join", name, appearance: 0, hostKey });
    const welcome = s.received.find((m) => m.t === "welcome");
    const self = welcome?.t === "welcome" ? welcome.players.find((p) => p.id === welcome.selfId) : undefined;
    return { s, self: self! };
  };
  /** Drain what everyone got so far, including joins waiting for the next snapshot. */
  const everyone = (...sockets: FakeSocket[]) => {
    tick();
    sockets.forEach((s) => s.take());
  };
  return { room, tick, join, everyone };
}

const voiceIn = (s: ServerMessage[]) => s.flatMap((m) => (m.t === "snapshot" ? m.voice.map((v) => [v.id, v.seq]) : []));

test("the host key makes the host, who sits in the sun and cannot move", () => {
  const { tick, join, everyone } = hostedRoom();
  const host = join("Hana", HOST_KEY);
  const guest = join("Gus", "wrong-key");
  assert.equal(host.self.role, "host");
  assert.deepEqual([host.self.x, host.self.y], [5000, 5000]);
  assert.equal(guest.self.role, "guest");
  everyone(host.s, guest.s);
  host.s.deliver({ t: "move", x: 5000, y: 5300, dir: "south", moving: true });
  tick(100);
  assert.deepEqual(guest.s.take(), []);
});

test("only the host chooses speakers, and everyone hears about it", () => {
  const { join, everyone } = hostedRoom();
  const host = join("Hana", HOST_KEY);
  const a = join("Ann");
  const b = join("Ben");
  everyone(host.s, a.s, b.s);
  a.s.deliver({ t: "set_role", id: b.self.id, role: "speaker" });
  assert.deepEqual(a.s.take().map((m) => m.t), ["error"]);
  assert.deepEqual(b.s.take(), []);
  host.s.deliver({ t: "set_role", id: b.self.id, role: "speaker" });
  for (const s of [host.s, a.s, b.s]) assert.deepEqual(s.take(), [{ t: "role", id: b.self.id, role: "speaker" }]);
  // Nobody can take the host role away through set_role.
  host.s.deliver({ t: "set_role", id: host.self.id, role: "guest" });
  assert.deepEqual(a.s.take(), []);
});

test("voice from the host and speakers rides the next snapshot; guests are muted", () => {
  const { tick, join, everyone } = hostedRoom();
  const host = join("Hana", HOST_KEY);
  const a = join("Ann");
  const b = join("Ben");
  host.s.deliver({ t: "set_role", id: a.self.id, role: "speaker" });
  everyone(host.s, a.s, b.s);
  const data = new Uint8Array([1, 2, 3]);
  host.s.deliver({ t: "voice", seq: 1, data });
  a.s.deliver({ t: "voice", seq: 7, data });
  b.s.deliver({ t: "voice", seq: 9, data }); // a guest: dropped
  tick(100);
  for (const s of [host.s, a.s, b.s]) {
    assert.deepEqual(voiceIn(s.take()), [
      [host.self.id, 1],
      [a.self.id, 7],
    ]);
  }
  // Back to guest: the next frame is dropped.
  host.s.deliver({ t: "set_role", id: a.self.id, role: "guest" });
  a.s.deliver({ t: "voice", seq: 8, data });
  tick(100);
  assert.deepEqual(voiceIn(b.s.take()), []);
});

test("oversized and too frequent voice frames are dropped", () => {
  const { tick, join, everyone } = hostedRoom();
  const host = join("Hana", HOST_KEY);
  const a = join("Ann");
  everyone(host.s, a.s);
  host.s.deliver({ t: "voice", seq: 1, data: new Uint8Array(513) });
  tick(100);
  assert.deepEqual(voiceIn(a.s.take()), []);
  // 8000 B/s budget: 500 B frames sent at once, only 16 get through.
  for (let i = 0; i < 40; i++) host.s.deliver({ t: "voice", seq: i, data: new Uint8Array(500) });
  tick(100);
  assert.equal(voiceIn(a.s.take()).length, 16);
});

test("the number of speakers is capped", () => {
  const { join, everyone } = hostedRoom();
  const host = join("Hana", HOST_KEY);
  const guests = Array.from({ length: 9 }, (_, i) => join(`G${i}`));
  everyone(host.s);
  for (const g of guests) host.s.deliver({ t: "set_role", id: g.self.id, role: "speaker" });
  const msgs = host.s.take();
  assert.equal(msgs.filter((m) => m.t === "role").length, 8);
  assert.deepEqual(msgs.at(-1)?.t, "error");
});

test("a second host tab takes over; the first one leaves the sun as a guest", () => {
  const { join, everyone } = hostedRoom();
  const first = join("Hana", HOST_KEY);
  everyone(first.s);
  const second = join("Hana", HOST_KEY);
  assert.equal(second.self.role, "host");
  const got = first.s.take();
  const correction = got.find((m) => m.t === "correction");
  assert.ok(correction?.t === "correction" && Math.hypot(correction.x - 5000, correction.y - 5000) > 200);
  assert.deepEqual(got.find((m) => m.t === "role"), { t: "role", id: first.self.id, role: "guest" });
});

test("cluster: roles and voice cross servers through the owner", () => {
  const sent = { roles: [] as unknown[], setRoles: [] as unknown[], voice: [] as number[][] };
  const { room, tick, join, everyone } = hostedRoom({
    sync: {
      ...quietSync,
      joined: () => {},
      left: () => {},
      moves: () => {},
      chat: () => {},
      role: (id, role) => sent.roles.push([id, role]),
      setRole: (owner, id, role) => sent.setRoles.push([owner, id, role]),
      voice: (frames) => sent.voice.push(frames.map((f) => f.id)),
    },
  });
  const host = join("Hana", HOST_KEY, 1);
  const local = join("Ann", "", 2);
  room.remoteJoined(5, remoteInfo); // id 42, a guest on server 5
  everyone(host.s, local.s);
  // Our host picks a remote player: the request goes to its server...
  host.s.deliver({ t: "set_role", id: 42, role: "speaker" });
  assert.deepEqual(sent.setRoles, [[5, 42, "speaker"]]);
  // ...which applies it and announces the change.
  room.remoteRole(5, 42, "speaker");
  assert.deepEqual(local.s.take(), [{ t: "role", id: 42, role: "speaker" }]);
  // A remote host picks our player.
  room.remoteSetRole(2, "speaker");
  assert.deepEqual(sent.roles, [[2, "speaker"]]);
  // Voice: local frames are mirrored; remote ones are relayed only for speakers of that server.
  local.s.take();
  local.s.deliver({ t: "voice", seq: 1, data: new Uint8Array([1]) });
  room.remoteVoice(5, [{ id: 42, seq: 1, data: new Uint8Array([2]) }]);
  room.remoteVoice(6, [{ id: 42, seq: 2, data: new Uint8Array([3]) }]); // wrong owner
  tick(100);
  assert.deepEqual(voiceIn(host.s.take()), [
    [2, 1],
    [42, 1],
  ]);
  assert.deepEqual(sent.voice, [[2]]);
});

test("a migrating speaker stays a speaker", async () => {
  const { room, join } = hostedRoom();
  join("Hana", HOST_KEY, 1);
  const moved = new FakeSocket();
  const resume = Promise.resolve({ ...remoteInfo, role: "speaker" as const });
  moved.events = room.accept(moved, 42, resume);
  moved.deliver({ t: "join", name: "Zed", appearance: 9, hostKey: "" });
  await resume;
  await Promise.resolve();
  const welcome = moved.take().find((m) => m.t === "welcome");
  assert.equal(welcome?.t === "welcome" && welcome.players.find((p) => p.id === 42)?.role, "speaker");
});

test("a join announced in the next snapshot carries the role given since", () => {
  const { tick, join, everyone } = hostedRoom();
  const host = join("Hana", HOST_KEY);
  const a = join("Ann");
  everyone(host.s, a.s);
  const b = join("Ben");
  host.s.deliver({ t: "set_role", id: b.self.id, role: "speaker" });
  tick();
  const snap = a.s.take().find((m) => m.t === "snapshot");
  assert.deepEqual(snap?.t === "snapshot" && snap.joined.map((p) => [p.id, p.role]), [[b.self.id, "speaker"]]);
});

test("idle rooms batch voice every 100 ms; a snapshot carries it at once", () => {
  const { tick, join, everyone } = hostedRoom();
  const host = join("Hana", HOST_KEY);
  const a = join("Ann");
  everyone(host.s, a.s);
  const data = new Uint8Array([1]);
  host.s.deliver({ t: "voice", seq: 1, data });
  tick(20);
  tick(40);
  assert.deepEqual(a.s.take(), []); // nobody moved: still waiting
  host.s.deliver({ t: "voice", seq: 2, data });
  tick(100);
  assert.deepEqual(voiceIn(a.s.take()), [
    [host.self.id, 1],
    [host.self.id, 2],
  ]);
  // Someone moves: the pending frame goes out with that tick's snapshot.
  host.s.deliver({ t: "voice", seq: 3, data });
  a.s.deliver({ t: "move", x: a.self.x + 1, y: a.self.y, dir: "east", moving: true });
  tick(0);
  const got = a.s.take();
  assert.equal(got.length, 1);
  assert.deepEqual(voiceIn(got), [[host.self.id, 3]]);
});

test("cluster: local voice goes to peers every tick, even while clients wait", () => {
  const frames: number[][] = [];
  const noop = () => {};
  const { tick, join } = hostedRoom({
    sync: {
      ...quietSync, joined: noop, left: noop, moves: noop, chat: noop, role: noop, setRole: noop, voice: (f) => frames.push(f.map((x) => x.seq)) },
  });
  const host = join("Hana", HOST_KEY, 1);
  host.s.deliver({ t: "voice", seq: 1, data: new Uint8Array([1]) });
  tick(0);
  host.s.deliver({ t: "voice", seq: 2, data: new Uint8Array([1]) });
  tick(0);
  tick(0);
  assert.deepEqual(frames, [[1], [2]]);
});

// ------------------------------------------------------------ snapshot groups

/** A cheap peer for filling big rooms: counts frames instead of decoding them. */
class CountingSocket {
  readonly channels = new Set<string>();
  frames = 0;
  events!: PeerEvents;
  send(): void {
    this.frames++;
  }
  subscribe(channel: string): void {
    this.channels.add(channel);
  }
  unsubscribe(channel: string): void {
    this.channels.delete(channel);
  }
  close(): void {
    this.events.close();
  }
}

/** A room with `n` players on a fake topic; `a` (the host) and `b` (decoded) land in groups 0 and 1. */
function bigRoom(n: number) {
  const topic = fakeTopic();
  const room = new Room("big", { onEmpty: () => {}, publish: topic.publish, isHostKey: (k) => k === HOST_KEY });
  const tick = (later = 0) => (room as unknown as { tick(now: number): void }).tick(Date.now() + later);
  const watch = (name: string, hostKey = "") => {
    const s = new FakeSocket();
    topic.sockets.push(s);
    s.events = room.accept(s);
    s.deliver({ t: "join", name, appearance: 0, hostKey });
    return s;
  };
  const a = watch("Ann", HOST_KEY);
  const b = watch("Ben");
  const crowd = Array.from({ length: n - 2 }, (_, i) => {
    const s = new CountingSocket();
    topic.sockets.push(s);
    s.events = room.accept(s);
    s.events.message(encodeClientMessage({ t: "join", name: `c${i}`, appearance: 0, hostKey: "" }));
    return s;
  });
  const selfOf = (s: FakeSocket) => {
    const w = s.received.find((m) => m.t === "welcome");
    return w?.t === "welcome" ? w.players.find((p) => p.id === w.selfId)! : null!;
  };
  return { room, topic, tick, a, b, crowd, selfOf, watch };
}

const snapshots = (msgs: ServerMessage[]) => msgs.filter((m) => m.t === "snapshot");

test("from 200 players the room ticks at 40 Hz in two groups: still 20 Hz per player", () => {
  const { room, tick, a, b, selfOf, watch } = bigRoom(200);
  assert.equal(room.snapshotHz, 20);
  // The players' rate did not change, so nobody is told anything.
  assert.ok(!a.received.some((m) => m.t === "rate"));
  const late = watch("Late");
  const welcome = late.received.find((m) => m.t === "welcome");
  assert.equal(welcome?.t === "welcome" && welcome.snapshotHz, 20);

  const ben = selfOf(b);
  a.take();
  b.take();
  b.deliver({ t: "move", x: ben.x + 1, y: ben.y, dir: "east", moving: true });
  tick();
  // One group per tick (a and b are in different groups).
  const first = [snapshots(a.take()).length, snapshots(b.take()).length];
  assert.equal(first[0] + first[1], 1);
  tick();
  // The other group gets the same move one tick later (everything since its last snapshot).
  const second = [snapshots(a.take()), snapshots(b.take())];
  const later = second[first[0] === 1 ? 1 : 0];
  assert.equal(later.length, 1);
  assert.deepEqual(later[0].t === "snapshot" && later[0].players.map((p) => p.id), [ben.id]);
});

test("overcharge: a lower rate is announced and keeps the two groups", () => {
  const { room, a, b } = bigRoom(200);
  room.setRate(16);
  assert.equal(room.snapshotHz, 16);
  for (const s of [a, b]) assert.deepEqual(s.take().filter((m) => m.t === "rate"), [{ t: "rate", snapshotHz: 16 }]);
  room.setRate(20);
  assert.equal(room.snapshotHz, 20);
  assert.deepEqual(a.take().filter((m) => m.t === "rate"), [{ t: "rate", snapshotHz: 20 }]);
});

test("in two groups, voice reaches each group at its own next tick", () => {
  const { room, tick, a, b } = bigRoom(200);
  room.setRate(10); // 100 ms between a group's snapshots: voice rides every one
  a.take();
  b.take();
  a.deliver({ t: "voice", seq: 1, data: new Uint8Array([1]) });
  tick();
  const first = [voiceIn(a.take()), voiceIn(b.take())];
  assert.equal(first[0].length + first[1].length, 1);
  tick();
  const second = [voiceIn(a.take()), voiceIn(b.take())];
  assert.deepEqual([first[0].length + second[0].length, first[1].length + second[1].length], [1, 1]);
});

test("below 150 players the room goes back to one group, flushing both backlogs", () => {
  const { room, tick, a, b, crowd, selfOf } = bigRoom(200);
  const ben = selfOf(b);
  tick(); // the groups' backlogs now differ
  for (const s of crowd.slice(0, 51)) s.close();
  assert.equal(room.playerCount, 149);
  assert.equal(room.snapshotHz, 20);
  a.take();
  b.take();
  b.deliver({ t: "move", x: ben.x + 1, y: ben.y, dir: "east", moving: true });
  tick();
  assert.equal(snapshots(a.take()).length, 1);
  assert.equal(snapshots(b.take()).length, 1);
});

test("a fixed 40 Hz x 2 groups schedule: 20 Hz per player, half per tick, mesh at 20 Hz", () => {
  const meshMoves: number[][] = [];
  const noop = () => {};
  const room = new Room("ab", {
    onEmpty: noop,
    schedule: { tickHz: 40, groups: 2 },
    sync: {
      ...quietSync, joined: noop, left: noop, moves: (ps) => meshMoves.push(ps.map((p) => p.id)), chat: noop, role: noop, setRole: noop, voice: noop },
  });
  const tick = () => (room as unknown as { tick(now: number): void }).tick(Date.now());
  const [a, b] = ["Ann", "Ben"].map((name) => {
    const s = new FakeSocket();
    s.events = room.accept(s);
    s.deliver({ t: "join", name, appearance: 0, hostKey: "" });
    return s;
  });
  const welcome = b.received.find((m) => m.t === "welcome");
  assert.equal(welcome?.t === "welcome" && welcome.snapshotHz, 20);
  const ben = welcome?.t === "welcome" ? welcome.players.find((p) => p.id === welcome.selfId)! : null!;
  a.take();
  b.take();
  b.deliver({ t: "move", x: ben.x + 1, y: ben.y, dir: "east", moving: true });
  tick();
  const first = [snapshots(a.take()).length, snapshots(b.take()).length];
  assert.equal(first[0] + first[1], 1);
  tick();
  const second = [snapshots(a.take()).length, snapshots(b.take()).length];
  assert.deepEqual([first[0] + second[0], first[1] + second[1]], [1, 1]);
  // Two room ticks, one mesh sync.
  assert.deepEqual(meshMoves, [[ben.id]]);
});

// ------------------------------------------------------------ area of interest

/** A room where players join at chosen spots (through the migration "resume" path). */
function aoiRoom() {
  const room = new Room("aoi", { onEmpty: () => {}, isHostKey: (k) => k === HOST_KEY });
  const tick = () => (room as unknown as { tick(now: number): void }).tick(Date.now() + 100);
  let nextId = 1;
  const at = async (name: string, x: number, y: number, hostKey = "") => {
    const s = new FakeSocket();
    const id = nextId++;
    const resume = Promise.resolve({ ...remoteInfo, id, name, x, y });
    s.events = room.accept(s, id, resume);
    s.deliver({ t: "join", name, appearance: 0, hostKey });
    await resume;
    await Promise.resolve();
    return { s, id };
  };
  return { room, tick, at };
}

const movedIds = (msgs: ServerMessage[]) => msgs.flatMap((m) => (m.t === "snapshot" ? m.players.map((p) => p.id) : []));

test("AOI: moves reach players in view, not those across the map", async () => {
  const { tick, at } = aoiRoom();
  const a = await at("Ann", 2000, 5000);
  const near = await at("Ned", 2300, 5000);
  const far = await at("Fay", 8000, 5000);
  for (const p of [a, near, far]) p.s.take();
  a.s.deliver({ t: "move", x: 2001, y: 5000, dir: "east", moving: true });
  tick();
  assert.deepEqual(movedIds(near.s.take()), [a.id]);
  assert.deepEqual(movedIds(far.s.take()), []);
});

test("AOI: the host and speakers are in view wherever they are, voice included", async () => {
  const { tick, at } = aoiRoom();
  const host = await at("Hana", 5000, 5000, HOST_KEY);
  const a = await at("Ann", 1500, 5000);
  const spk = await at("Sam", 8200, 5000);
  host.s.deliver({ t: "set_role", id: spk.id, role: "speaker" });
  for (const p of [host, a, spk]) p.s.take();
  spk.s.deliver({ t: "move", x: 8201, y: 5000, dir: "east", moving: true });
  spk.s.deliver({ t: "voice", seq: 1, data: new Uint8Array([1]) });
  tick();
  const got = a.s.take();
  assert.deepEqual(movedIds(got), [spk.id]);
  assert.deepEqual(voiceIn(got), [[spk.id, 1]]);
});

test("AOI: entering another cell sends who just came into view, idle players included", async () => {
  const { at } = aoiRoom();
  // 1874.5 is just left of a cell edge (5 x 375 = 1875).
  const a = await at("Ann", 1874.5, 5000);
  // Just beyond the old view, inside the new one.
  const idle = await at("Ida", 1874.5 + 1500 + 300, 5000);
  const seen = await at("Sid", 2300, 5000); // already in view: not sent again
  const far = await at("Fay", 8000, 5000);
  a.s.take();
  a.s.deliver({ t: "move", x: 1875.5, y: 5000, dir: "east", moving: true });
  const view = a.s.take().find((m) => m.t === "view");
  const ids = view?.t === "view" ? view.players.map((p) => p.id) : [];
  assert.ok(ids.includes(idle.id));
  assert.ok(!ids.includes(seen.id));
  assert.ok(!ids.includes(far.id));
  assert.ok(!ids.includes(a.id));
  // Moving inside the same cell sends no view.
  a.s.deliver({ t: "move", x: 1876, y: 5000, dir: "east", moving: true });
  assert.ok(!a.s.take().some((m) => m.t === "view"));
});

// ------------------------------------------------------------ reactions, hands, polls

const snapshotsOf = (msgs: ServerMessage[]) => msgs.flatMap((m) => (m.t === "snapshot" ? [m] : []));

test("reactions ride the next snapshot, five in a burst at most", () => {
  const { tick, join, everyone } = hostedRoom();
  const a = join("Ann");
  const b = join("Ben");
  everyone(a.s, b.s);
  for (let i = 0; i < 8; i++) a.s.deliver({ t: "react", kind: i % 6 });
  assert.deepEqual(b.s.take(), []);
  tick();
  const reactions = snapshotsOf(b.s.take()).flatMap((m) => m.reactions);
  assert.deepEqual(reactions.map((r) => [r.id, r.kind]), [0, 1, 2, 3, 4].map((k) => [a.self.id, k]));
});

test("guests raise hands in order; the host lowers them, and inviting a speaker does too", () => {
  const { tick, join, everyone } = hostedRoom();
  const host = join("Hana", HOST_KEY);
  const a = join("Ann");
  const b = join("Ben");
  everyone(host.s, a.s, b.s);
  a.s.deliver({ t: "hand", id: a.self.id, up: true });
  b.s.deliver({ t: "hand", id: b.self.id, up: true });
  host.s.deliver({ t: "hand", id: host.self.id, up: true }); // the host has the floor already
  tick();
  const hands = snapshotsOf(host.s.take()).flatMap((m) => m.hands);
  assert.deepEqual(hands.map((h) => h.id), [a.self.id, b.self.id]);
  assert.ok(hands.every((h) => h.hand > 0));
  everyone(a.s, b.s);

  // A newcomer sees raised hands in its welcome.
  const late = join("Cat");
  const welcome = late.s.take().find((m) => m.t === "welcome");
  assert.ok(welcome?.t === "welcome" && welcome.players.find((p) => p.id === a.self.id)!.hand > 0);

  // Only the host may lower someone else's hand.
  a.s.deliver({ t: "hand", id: b.self.id, up: false });
  host.s.deliver({ t: "hand", id: a.self.id, up: false });
  host.s.deliver({ t: "set_role", id: b.self.id, role: "speaker" });
  tick();
  const lowered = snapshotsOf(late.s.take()).flatMap((m) => m.hands);
  assert.deepEqual(lowered, [{ id: a.self.id, hand: 0 }, { id: b.self.id, hand: 0 }]);
  // A speaker cannot raise a hand.
  b.s.deliver({ t: "hand", id: b.self.id, up: true });
  tick();
  assert.deepEqual(snapshotsOf(late.s.take()).flatMap((m) => m.hands), []);
});

test("the host runs a poll answered by flying to a planet", () => {
  const { room, tick, join, everyone } = hostedRoom();
  const host = join("Hana", HOST_KEY);
  const a = join("Ann");
  everyone(host.s, a.s);
  a.s.deliver({ t: "poll_start", question: "Tea?", options: ["Yes", "No"] });
  assert.deepEqual(a.s.take().map((m) => m.t), ["error"]);
  host.s.deliver({ t: "poll_start", question: "  Tea?  ", options: ["Yes", " ", "No"] });
  const started = a.s.take().find((m) => m.t === "poll");
  assert.ok(started?.t === "poll");
  assert.deepEqual([started.poll.question, started.poll.options, started.poll.open], ["Tea?", ["Yes", "No"], true]);

  // Players of another server: two fly to "No" (the bottom planet); one appears
  // there without moving, which is not a vote.
  const [, no] = pollZones(2);
  for (const id of [42, 43, 44]) room.remoteJoined(2, { ...remoteInfo, id, x: no.x, y: no.y - 20 });
  room.remoteMoves(2, [42, 43].map((id) => ({ id, x: no.x, y: no.y, dir: "south" as const, moving: false })));
  tick(POLL_COUNT_MS + 10);
  assert.deepEqual(snapshotsOf(a.s.take()).map((m) => m.pollCounts).filter((c) => c.length), [[0, 2]]);

  // A newcomer gets the open poll in its welcome.
  const late = join("Cat");
  const welcome = late.s.take().find((m) => m.t === "welcome");
  assert.equal(welcome?.t === "welcome" && welcome.poll?.id, started.poll.id);

  host.s.deliver({ t: "poll_end" });
  const ended = a.s.take().find((m) => m.t === "poll");
  assert.ok(ended?.t === "poll");
  assert.deepEqual([ended.poll.open, ended.poll.counts], [false, [0, 2]]);
});

test("cluster: hands, reactions and polls are mirrored to peers", () => {
  const sent: string[] = [];
  const { room, tick, join, everyone } = hostedRoom({
    sync: {
      ...quietSync,
      reactions: (list) => sent.push(`react:${list.length}`),
      hand: (id, hand) => sent.push(`hand:${id}:${hand > 0}`),
      setHand: (owner, id, hand) => sent.push(`set_hand:${owner}:${id}:${hand}`),
      poll: (poll) => sent.push(`poll:${poll.open}`),
    },
  });
  const host = join("Hana", HOST_KEY, 1);
  const a = join("Ann", "", 2);
  everyone(host.s, a.s);
  room.remoteJoined(5, { ...remoteInfo, hand: 123 });
  a.s.deliver({ t: "react", kind: 0 });
  a.s.deliver({ t: "hand", id: 2, up: true });
  host.s.deliver({ t: "hand", id: 42, up: false }); // a hand on server 5
  host.s.deliver({ t: "poll_start", question: "Q", options: ["a", "b"] });
  host.s.deliver({ t: "poll_end" });
  tick();
  assert.deepEqual(sent, ["hand:2:true", "set_hand:5:42:0", "poll:true", "poll:false", "react:1"]);

  // From a peer: its host's poll, and its player's lowered hand.
  room.remotePoll({ id: 9, question: "Q2", options: ["x", "y", "z"], open: true, counts: [] });
  room.remoteHand(5, 42, 0);
  tick();
  const got = a.s.take();
  assert.ok(got.some((m) => m.t === "poll" && m.poll.id === 9 && m.poll.counts.length === 3));
  assert.ok(snapshotsOf(got).some((m) => m.hands.some((h) => h.id === 42 && h.hand === 0)));
});

test("snapshots carry the tick's time and how old each position is", () => {
  const { tick, join, everyone } = hostedRoom();
  const a = join("Ann");
  const b = join("Ben");
  everyone(a.s, b.s);
  const movedAt = Date.now();
  a.s.deliver({ t: "move", x: a.self.x + 1, y: a.self.y, dir: "east", moving: true });
  tick(40);
  const snap = snapshotsOf(b.s.take()).at(-1)!;
  const entry = snap.players.find((p) => p.id === a.self.id)!;
  assert.ok(Math.abs(snap.time - ((movedAt + 40) % 2 ** 32)) < 20);
  assert.ok(entry.age >= 35 && entry.age <= 60, `age ${entry.age}`);
});

test("a socket that missed a join sees the player in snapshots without knowing who it is", () => {
  const topic = fakeTopic();
  const { room, tick, sockets, done } = setup(topic);
  const [ann] = sockets;
  ann.dropping = true; // e.g. a phone in the background with a full send buffer
  const dan = new FakeSocket();
  topic.sockets.push(dan);
  dan.events = room.accept(dan);
  dan.deliver({ t: "join", name: "Dan", appearance: 9, hostKey: "" });
  const w = dan.take().find((m) => m.t === "welcome");
  const danId = w?.t === "welcome" ? w.selfId : -1;
  const me = w?.t === "welcome" ? w.players.find((p) => p.id === danId)! : null!;
  tick();
  ann.dropping = false;
  dan.deliver({ t: "move", x: me.x + 1, y: me.y, dir: "east", moving: true });
  tick();
  const got = ann.take();
  assert.ok(snapshotsOf(got).some((m) => m.players.some((p) => p.id === danId)));
  assert.deepEqual(joinedIn(got), []); // the join is gone for good

  // The fix: ask who they are.
  ann.deliver({ t: "who", ids: [danId, 9999] });
  const reply = ann.take().find((m) => m.t === "players");
  assert.ok(reply?.t === "players");
  assert.deepEqual(reply.players.map((p) => [p.id, p.name]), [[danId, "Dan"]]);
  assert.deepEqual(reply.missing, [9999]);
  // Asking again right away is ignored (rate limit).
  ann.deliver({ t: "who", ids: [danId] });
  assert.deepEqual(ann.take(), []);
  dan.close();
  done();
});

// ------------------------------------------------------------ orbit mode

test("the host gathers everyone: speakers on the stage, guests on the rings, nobody moves, no polls", () => {
  const { tick, join, everyone } = hostedRoom();
  const host = join("Hana", HOST_KEY);
  const a = join("Ann");
  const b = join("Ben");
  everyone(host.s, a.s, b.s);
  host.s.deliver({ t: "set_role", id: b.self.id, role: "speaker" });
  host.s.deliver({ t: "poll_start", question: "Tea?", options: ["Yes", "No"] });
  everyone(host.s, a.s, b.s);

  a.s.deliver({ t: "gather" });
  assert.deepEqual(a.s.take().map((m) => m.t), ["error"]);
  host.s.deliver({ t: "gather" });
  const got = a.s.take();
  // The open poll ends first.
  assert.deepEqual(got.map((m) => m.t), ["poll", "orbit"]);
  const orbit = got[1];
  assert.ok(orbit.t === "orbit" && orbit.active);
  const seat = new Map(orbit.slots.map((s) => [s.id, s.slot]));
  assert.equal(seat.has(host.self.id), false);
  assert.ok(seat.get(b.self.id)! < STAGE_SLOTS);
  assert.ok(seat.get(a.self.id)! >= STAGE_SLOTS);

  // Moves are ignored (no correction either), polls refused.
  a.s.deliver({ t: "move", x: a.self.x + 1, y: a.self.y, dir: "east", moving: true });
  tick();
  assert.deepEqual(snapshotsOf(b.s.take()).flatMap((m) => m.players), []);
  assert.deepEqual(a.s.take().filter((m) => m.t === "correction"), []);
  host.s.take();
  host.s.deliver({ t: "poll_start", question: "Q", options: ["x", "y"] });
  assert.deepEqual(host.s.take().map((m) => m.t), ["error"]);
});

test("in orbit: newcomers get a seat, new speakers move to the stage, the host leaving changes nothing", () => {
  const { tick, join, everyone } = hostedRoom();
  const host = join("Hana", HOST_KEY);
  const a = join("Ann");
  everyone(host.s, a.s);
  host.s.deliver({ t: "gather" });
  everyone(host.s, a.s);

  const late = join("Cat");
  const welcome = late.s.take().find((m) => m.t === "welcome");
  assert.ok(welcome?.t === "welcome" && welcome.orbit);
  const lateSeat = welcome.orbit.slots.find((s) => s.id === late.self.id)?.slot;
  assert.ok(lateSeat !== undefined && lateSeat >= STAGE_SLOTS);
  tick();
  assert.deepEqual(snapshotsOf(a.s.take()).flatMap((m) => m.slots), [{ id: late.self.id, slot: lateSeat }]);

  host.s.deliver({ t: "set_role", id: a.self.id, role: "speaker" });
  tick();
  const moved = snapshotsOf(late.s.take()).flatMap((m) => m.slots);
  assert.ok(moved.some((s) => s.id === a.self.id && s.slot < STAGE_SLOTS));

  host.s.close();
  const back = join("Hana", HOST_KEY);
  const again = back.s.take().find((m) => m.t === "welcome");
  assert.ok(again?.t === "welcome" && again.orbit !== null);
});

test("release: everyone stays where the orbit had them, and can walk on from there", () => {
  const { tick, join, everyone } = hostedRoom();
  const host = join("Hana", HOST_KEY);
  const a = join("Ann");
  everyone(host.s, a.s);
  host.s.deliver({ t: "gather" });
  const start = host.s.take().find((m) => m.t === "orbit");
  assert.ok(start?.t === "orbit");
  const seat = start.slots.find((s) => s.id === a.self.id)!.slot;
  a.s.take();
  host.s.deliver({ t: "release" });
  const end = a.s.take().find((m) => m.t === "orbit");
  assert.ok(end?.t === "orbit" && !end.active);
  const at = orbitPosition(seat, ((end.now - start.start + 2 ** 32) % 2 ** 32) / 1000);
  // From exactly that spot a step is accepted (no correction) and seen by others.
  a.s.deliver({ t: "move", x: quantize(at.x) + 2, y: quantize(at.y), dir: "east", moving: true });
  tick(30);
  assert.deepEqual(a.s.take().filter((m) => m.t === "correction"), []);
  const seen = snapshotsOf(host.s.take()).flatMap((m) => m.players).find((p) => p.id === a.self.id);
  assert.deepEqual(seen && [seen.x, seen.y], [quantize(at.x) + 2, quantize(at.y)]);
});
