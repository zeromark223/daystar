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
  readonly channels = new Set<string>();
  get subscribed(): boolean {
    return this.channels.size > 0;
  }
  subscribe(channel: string): void {
    this.channels.add(channel);
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
  // Everyone gets room events plus one of the two snapshot group channels.
  assert.ok(sockets.every((s) => s.channels.has("") && s.channels.size === 2));
  const before = topic.publishes;
  sockets[0].deliver({ t: "move", x: self.x + 1, y: self.y, dir: "east", moving: true });
  tick();
  // One room, one group: the same snapshot goes to both group channels, every player once.
  assert.equal(topic.publishes, before + 2);
  for (const s of sockets) assert.equal(s.take().filter((m) => m.t === "snapshot").length, 1);
  done();
});

test("with publish, a newcomer gets welcome but not its own join", () => {
  const topic = fakeTopic();
  const { room, sockets, done } = setup(topic);
  const late = new FakeSocket();
  topic.sockets.push(late);
  late.events = room.accept(late);
  late.deliver({ t: "join", name: "Dan", appearance: 9, hostKey: "" });
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
      role: () => {},
      setRole: () => {},
      voice: () => {},
    },
  });
  const tick = () => (room as unknown as { tick(): void }).tick();
  const local = new FakeSocket();
  local.events = room.accept(local, 7);
  local.deliver({ t: "join", name: "Ann", appearance: 0, hostKey: "" });
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
};

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
  late.deliver({ t: "join", name: "Bo", appearance: 9, hostKey: "" });
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
  moved.deliver({ t: "join", name: "Zed", appearance: 9, hostKey: "" });
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
  const everyone = (...sockets: FakeSocket[]) => sockets.forEach((s) => s.take());
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
    sync: { joined: noop, left: noop, moves: noop, chat: noop, role: noop, setRole: noop, voice: (f) => frames.push(f.map((x) => x.seq)) },
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

test("from 700 players the room serves two groups on alternate ticks", () => {
  const { room, topic, tick, a, b, selfOf, watch } = bigRoom(700);
  assert.equal(room.snapshotHz, 10);
  // Players already there were told; a newcomer's welcome says so.
  assert.ok(a.received.some((m) => m.t === "rate" && m.snapshotHz === 10));
  const late = watch("Late");
  assert.equal(late.received.find((m) => m.t === "welcome")?.t === "welcome" && (late.received.find((m) => m.t === "welcome") as { snapshotHz: number }).snapshotHz, 10);

  const ben = selfOf(b);
  a.take();
  b.take();
  const before = topic.publishes;
  b.deliver({ t: "move", x: ben.x + 1, y: ben.y, dir: "east", moving: true });
  tick();
  // One group's channel per tick.
  assert.equal(topic.publishes, before + 1);
  const first = [snapshots(a.take()).length, snapshots(b.take()).length];
  assert.equal(first[0] + first[1], 1);
  tick();
  // The other group gets the same move one tick later (everything since its last snapshot).
  const second = [snapshots(a.take()), snapshots(b.take())];
  const late2 = second[first[0] === 1 ? 1 : 0];
  assert.equal(late2.length, 1);
  assert.deepEqual(late2[0].t === "snapshot" && late2[0].players.map((p) => p.id), [ben.id]);
});

test("in two groups, voice reaches each group at its own next tick", () => {
  const { tick, a, b } = bigRoom(700);
  a.take();
  b.take();
  a.deliver({ t: "voice", seq: 1, data: new Uint8Array([1]) });
  tick(); // nobody moved: voice still goes out (no 100 ms wait on top of the group's)
  const first = [voiceIn(a.take()), voiceIn(b.take())];
  assert.equal(first[0].length + first[1].length, 1);
  tick();
  const second = [voiceIn(a.take()), voiceIn(b.take())];
  assert.deepEqual([first[0].length + second[0].length, first[1].length + second[1].length], [1, 1]);
});

test("below 600 players the room goes back to one group, flushing both backlogs", () => {
  const { room, tick, a, b, crowd, selfOf } = bigRoom(700);
  const ben = selfOf(b);
  for (const s of crowd.slice(0, 101)) s.close();
  assert.equal(room.playerCount, 599);
  assert.equal(room.snapshotHz, 20);
  assert.ok(b.received.some((m) => m.t === "rate" && m.snapshotHz === 20));
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
    sync: { joined: noop, left: noop, moves: (ps) => meshMoves.push(ps.map((p) => p.id)), chat: noop, role: noop, setRole: noop, voice: noop },
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
