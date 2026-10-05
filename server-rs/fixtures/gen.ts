/**
 * Golden frames for the Rust server's protocol tests: messages encoded (and
 * decoded) by the TypeScript protocol, the one browsers use. Regenerate with
 *   bun server-rs/fixtures/gen.ts
 */
import { writeFileSync } from "node:fs";
import {
  decodeClientMessage,
  encodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../shared/src/protocol.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (b: Uint8Array) => [...b];

const info = (id: number, name: string, role: "guest" | "speaker" | "host") => ({
  id,
  name,
  appearance: (id * 5) % 24,
  x: 1234.25 + id,
  y: 9876.5 - id,
  dir: (["south", "west", "east", "north"] as const)[id % 4],
  moving: id % 2 === 0,
  role,
});
const state = (id: number) => ({ id, x: 100.75 * id, y: 50.25 * id, dir: "east" as const, moving: id % 3 === 0 });
const chat = { id: 3, playerId: 7, name: "Mochi 🌟", text: "Xin chào mọi người", ts: 1_790_219_348_670 };

const server: ServerMessage[] = [
  { t: "welcome", selfId: 7, players: [info(7, "Mochi 🌟", "host"), info(8, "Bé Na", "speaker"), info(9, "Gus", "guest")], chat: [chat], snapshotHz: 20 },
  { t: "welcome", selfId: 1, players: [info(1, "A", "guest")], chat: [], snapshotHz: 10 },
  { t: "player_joined", player: info(42, "Zed", "guest") },
  { t: "player_left", id: 65535 },
  { t: "chat", message: chat },
  { t: "correction", x: 4999.75, y: 0 },
  { t: "error", message: "There can be at most 8 speakers." },
  { t: "snapshot", players: [state(1), state(2), state(30)], voice: [], joined: [], left: [] },
  { t: "snapshot", players: [], voice: [{ id: 2, seq: 65535, data: new Uint8Array([1, 2, 3, 250]) }], joined: [], left: [] },
  { t: "snapshot", players: [state(3)], voice: [], joined: [info(9, "Gus", "guest"), info(10, "Bé Na", "speaker")], left: [4, 513] },
  { t: "role", id: 9, role: "speaker" },
  { t: "rate", snapshotHz: 14 },
  { t: "view", from: 13 * 64 + 5, to: 13 * 64 + 6, players: [state(4), state(5)] },
  { t: "migrate" },
];

const client: ClientMessage[] = [
  { t: "join", name: "  Mochi 🌟  ", appearance: 23, hostKey: "" },
  { t: "join", name: "Host", appearance: 0, hostKey: "abcDEF-_123" },
  { t: "chat", text: "Xin chào" },
  { t: "move", x: 123.25, y: 9876.75, dir: "north", moving: true },
  { t: "set_role", id: 9, role: "speaker" },
  { t: "set_role", id: 9, role: "guest" },
  { t: "voice", seq: 513, data: new Uint8Array([9, 8, 7]) },
];

// Frames a client might send that must be rejected (decode to null).
const badClient = [
  new Uint8Array([]),
  new Uint8Array([99, 1, 2]),
  new Uint8Array([1, 1, 0, 65, 200, 0, 0]), // appearance 200
  new Uint8Array([4, 1, 0, 2]), // set_role host
  new Uint8Array([3, 1, 0, 2, 0, 8]), // motion > 7
  encodeClientMessage({ t: "move", x: 1, y: 2, dir: "south", moving: false }).subarray(0, 5), // truncated
  new Uint8Array([2, 5, 0, 104, 105]), // string past the end
  new Uint8Array([3, 1, 0, 2, 0, 3, 0]), // trailing byte
  encodeServerMessage({ t: "player_left", id: 1 }),
];

const fixtures = {
  server: server.map((m) => ({ message: m, hex: hex(encodeServerMessage(m)) })),
  client: client.map((m) => {
    const frame = encodeClientMessage(m);
    return { message: decodeClientMessage(frame), hex: hex(frame) };
  }),
  badClient: badClient.map((b) => {
    if (decodeClientMessage(b) !== null) throw new Error(`expected ${hex(b)} to be rejected`);
    return hex(b);
  }),
};

writeFileSync(
  new URL("protocol.json", import.meta.url),
  JSON.stringify(fixtures, (_k, v) => (v instanceof Uint8Array ? bytes(v) : v), 2) + "\n",
);
console.log(`wrote ${fixtures.server.length} server, ${fixtures.client.length} client, ${fixtures.badClient.length} bad frames`);
