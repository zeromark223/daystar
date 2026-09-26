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

function setup() {
  const room = new Room("test", map, () => {});
  const tick = () => (room as unknown as { tick(): void }).tick();
  const sockets = ["Ann", "Ben", "Cat"].map((name) => {
    const s = new FakeSocket();
    s.events = room.accept(s);
    s.deliver({ t: "join", name, character: "rabbit_white" });
    return s;
  });
  const welcome = sockets[0].received.find((m) => m.t === "welcome")!;
  const self = welcome.t === "welcome" ? welcome.players.find((p) => p.id === welcome.selfId)! : null!;
  for (const s of sockets) s.take();
  const done = () => sockets.forEach((s) => s.close());
  return { tick, sockets, self, done };
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
