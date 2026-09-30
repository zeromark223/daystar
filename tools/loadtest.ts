/**
 * Load test: ramps up bot players in steps and reports whether each step
 * stays healthy. Bots join, walk non-stop (worst case: everyone moving) using
 * the world's real limits (sun and edge), send positions at the client rate and chat now and then.
 * With --speakers, each room also gets a host and speakers who hold a conversation
 * with real Opus frames (tools/voice/*.ogg), so a browser joining the room hears it.
 *
 *   bun tools/loadtest.ts --steps 100,200,400 --room-size 20
 *   bun tools/loadtest.ts --target https://meet.example.com --steps 200,500
 *
 * `bun run loadtest …` works too on Linux and macOS; on Windows Bun's script shell
 * can drop flags, so call the file directly there.
 *
 * Run with --help for the options (USAGE below).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { APPEARANCE_COUNT, type AppearanceId } from "../shared/src/appearance.ts";
import type { Direction } from "../shared/src/direction.ts";
import { canBeAt, moveInSpace } from "../shared/src/space.ts";
import { MAX_SPEAKERS, MOVE_SPEED, ROOM_ID_PATTERN, TICK_RATE, VOICE_FRAME_MS, WS_PATH } from "../shared/src/constants.ts";
import {
  decodeServerMessage,
  encodeClientMessage,
  POSITION_SCALE,
  quantize,
  SNAPSHOT_OPCODE,
} from "../shared/src/protocol.ts";
import { readOpusPackets } from "./voice/ogg.ts";

const ROOT = resolve(import.meta.dirname, "..");
const HIST_MAX_MS = 5000;

// ---------------------------------------------------------------- histogram

/** 1 ms buckets up to HIST_MAX_MS; mergeable across processes. */
class Histogram {
  counts = new Map<number, number>();
  add(ms: number): void {
    const b = Math.min(HIST_MAX_MS, Math.max(0, Math.round(ms)));
    this.counts.set(b, (this.counts.get(b) ?? 0) + 1);
  }
  merge(entries: [number, number][]): void {
    for (const [b, n] of entries) this.counts.set(b, (this.counts.get(b) ?? 0) + n);
  }
  get total(): number {
    let t = 0;
    for (const n of this.counts.values()) t += n;
    return t;
  }
  percentile(p: number): number {
    const total = this.total;
    if (total === 0) return NaN;
    const target = Math.ceil(total * p);
    let seen = 0;
    for (const b of [...this.counts.keys()].sort((a, c) => a - c)) {
      seen += this.counts.get(b)!;
      if (seen >= target) return b;
    }
    return HIST_MAX_MS;
  }
  entries(): [number, number][] {
    return [...this.counts.entries()];
  }
}

interface WorkerReport {
  connected: number;
  snapshots: number;
  bytesIn: number;
  bytesOut: number;
  gaps: [number, number][];
  chat: [number, number][];
  /** Move sent -> own position seen in a snapshot. */
  move: [number, number][];
  corrections: number;
  closes: number;
  errors: number;
  /** Bots that moved to another server when asked (cluster). */
  migrations: number;
  /** Bots that rejoined after their socket dropped. */
  rejoins: number;
  /** Voice frames sent by this worker's talkers, per room. */
  voiceSent: [string, number][];
  /** Voice frames received by this worker's bots. */
  voiceRx: number;
  /** Frame spoken (end of its 20 ms) -> received by a bot, through the server. */
  voice: [number, number][];
}

// ---------------------------------------------------------------- worker

const DIRS: { dx: number; dy: number; dir: Direction }[] = [
  { dx: 1, dy: 0, dir: "east" },
  { dx: -1, dy: 0, dir: "west" },
  { dx: 0, dy: 1, dir: "south" },
  { dx: 0, dy: -1, dir: "north" },
  { dx: 0.707, dy: 0.707, dir: "south" },
  { dx: -0.707, dy: 0.707, dir: "south" },
  { dx: 0.707, dy: -0.707, dir: "north" },
  { dx: -0.707, dy: -0.707, dir: "north" },
];

interface Bot {
  ws: WebSocket;
  room: string;
  /** Cluster ticket for /api/migrate (null standalone). */
  ticket: string | null;
  name: string;
  /** A migration or rejoin is in flight. */
  switching: boolean;
  appearance: AppearanceId;
  id: number;
  x: number;
  y: number;
  heading: number;
  nextTurn: number;
  nextChat: number;
  lastSnapshot: number;
  joined: boolean;
  /** Walking or standing, and until when (see --moving). */
  walking: boolean;
  phaseUntil: number;
  /** Recently sent positions (wire units) awaiting their echo in a snapshot. */
  pending: { xw: number; yw: number; t: number }[];
  /** What the bot is meant to be (--speakers); guests walk, talkers stand and talk. */
  part: "host" | "speaker" | "guest";
  hostKey: string;
  /** Its role as the server last said. */
  role: "host" | "speaker" | "guest";
  /** Talkers: which voice sample, and the next packet in it. */
  voice: number;
  voicePos: number;
}

/**
 * One room's conversation: one talker at a time in turns of 2-6 s with short
 * pauses, and now and then a second one cutting in for a moment.
 */
interface Conversation {
  talkers: Bot[];
  current: number;
  speakFrom: number;
  turnUntil: number;
  overlap: { talker: number; from: number; until: number } | null;
  /** Last voice frame index handled (frames are numbered from the shared epoch). */
  lastFrame: number;
}

/** Voice frames of the samples, loaded once per worker when needed. */
let voiceSamples: Uint8Array[][] | null = null;
function voiceSample(i: number): Uint8Array[] {
  voiceSamples ??= [0, 1, 2].map((n) => readOpusPackets(resolve(ROOT, `tools/voice/speaker-${n}.ogg`)));
  return voiceSamples[i % voiceSamples.length];
}

/** Snapshot body: UInt16 count, then per player id, x, y (UInt16 LE) and motion (UInt8). */
const SNAPSHOT_ENTRY = 7;

/** Position of `id` in a raw snapshot frame, in wire units, without a full decode. */
function findInSnapshot(data: DataView, id: number): { xw: number; yw: number } | null {
  const count = data.getUint16(1, true);
  for (let i = 0, o = 3; i < count; i++, o += SNAPSHOT_ENTRY) {
    if (data.getUint16(o, true) === id) return { xw: data.getUint16(o + 2, true), yw: data.getUint16(o + 4, true) };
  }
  return null;
}

const toWire = (v: number) => Math.round(v * POSITION_SCALE);

/** Average walk burst; idle stretches are sized so walking takes `ratio` of the time. */
const WALK_MS = 3000;
function walkMs(): number {
  return WALK_MS * (1 / 3 + (Math.random() * 4) / 3); // 1-5 s
}
function idleMs(ratio: number): number {
  return ((WALK_MS * (1 - ratio)) / ratio) * (0.5 + Math.random());
}

function runWorker(): void {
  const bots: Bot[] = [];
  /** Base HTTP URL of the agent (cluster) or the server (standalone). */
  let baseUrl = "";
  let chatEveryMs = 30_000;
  let movingRatio = 1;
  /**
   * Shared clock for voice (Date.now() at the start of the test): frame k covers
   * [epoch + 20k, epoch + 20(k+1)) ms and is sent with seq = k & 0xffff, like the
   * client's mic-time seq. Any bot can then tell when a frame was spoken.
   */
  let voiceEpoch = 0;
  let gaps = new Histogram();
  let chat = new Histogram();
  let move = new Histogram();
  let voiceLatency = new Histogram();
  let voiceSent = new Map<string, number>();
  const newCounters = () => ({
    snapshots: 0,
    bytesIn: 0,
    bytesOut: 0,
    corrections: 0,
    closes: 0,
    errors: 0,
    migrations: 0,
    rejoins: 0,
    voiceRx: 0,
  });
  let counters = newCounters();
  const conversations = new Map<string, Conversation>();

  /** Like the web client: ask the agent (or server) where to connect; retries a few times. */
  async function place(path: string, body: object): Promise<{ url: string; ticket: string | null } | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const { wsUrl, ticket } = (await res.json()) as { wsUrl: string; ticket?: string };
          const base = new URL(baseUrl);
          const url = wsUrl.startsWith("/") ? `${base.protocol === "https:" ? "wss:" : "ws:"}//${base.host}${wsUrl}` : wsUrl;
          return { url, ticket: ticket ?? null };
        }
        if (res.status === 409) return null; // not asked to migrate (any more)
      } catch {
        // retried below
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    counters.errors++;
    return null;
  }

  async function addBot(room: string, name: string, part: Bot["part"], hostKey: string, voice: number): Promise<void> {
    const placed = await place("/api/join", { room });
    if (!placed) return;
    const appearance = Math.floor(Math.random() * APPEARANCE_COUNT);
    const bot: Bot = {
      part,
      hostKey,
      role: "guest",
      voice,
      voicePos: Math.floor(Math.random() * 200),
      ws: null!,
      room,
      ticket: placed.ticket,
      name,
      appearance,
      id: -1,
      x: 0,
      y: 0,
      heading: Math.floor(Math.random() * DIRS.length),
      nextTurn: 0,
      nextChat: chatEveryMs > 0 && part === "guest" ? Date.now() + Math.random() * chatEveryMs : Infinity,
      lastSnapshot: 0,
      joined: false,
      switching: false,
      walking: true,
      phaseUntil: 0,
      pending: [],
    };
    // Start at a random point of the walk/idle cycle so the room mixes both.
    if (part !== "guest") {
      // Talkers stand still (the host cannot move anyway).
      bot.walking = false;
      bot.phaseUntil = Infinity;
      joinConversation(bot);
    } else if (movingRatio <= 0 || movingRatio >= 1) {
      bot.walking = movingRatio > 0;
      bot.phaseUntil = Infinity;
    } else {
      bot.walking = Math.random() < movingRatio;
      bot.phaseUntil = Date.now() + Math.random() * (bot.walking ? walkMs() : idleMs(movingRatio));
    }
    connect(bot, placed.url);
    bots.push(bot);
  }

  /** Open a socket for the bot and make it the current one (join, then drop the old socket). */
  function connect(bot: Bot, url: string): void {
    const old = bot.ws as WebSocket | null;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    bot.ws = ws;
    bot.pending = [];
    ws.addEventListener("open", () => {
      ws.send(encodeClientMessage({ t: "join", name: bot.name, appearance: bot.appearance, hostKey: bot.hostKey }));
      if (old && old !== ws) old.close();
    });
    ws.addEventListener("message", (event) => {
      if (bot.ws !== ws || !(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      counters.bytesIn += bytes.byteLength;
      const now = performance.now();
      // Snapshots are only scanned for our own entry, not decoded, to keep bots cheap.
      if (bytes[0] === SNAPSHOT_OPCODE) {
        counters.snapshots++;
        if (bot.lastSnapshot) gaps.add(now - bot.lastSnapshot);
        bot.lastSnapshot = now;
        if (voiceEpoch) readVoice(new DataView(event.data));
        const own = bot.pending.length ? findInSnapshot(new DataView(event.data), bot.id) : null;
        if (own) {
          const i = bot.pending.findLastIndex((p) => p.xw === own.xw && p.yw === own.yw);
          if (i >= 0) {
            move.add(now - bot.pending[i].t);
            bot.pending.splice(0, i + 1);
          }
        }
        return;
      }
      const msg = decodeServerMessage(bytes);
      if (msg?.t === "welcome") {
        const self = msg.players.find((p) => p.id === msg.selfId)!;
        bot.id = msg.selfId;
        bot.x = self.x;
        bot.y = self.y;
        bot.role = self.role;
        bot.joined = true;
        if (bot.part !== "guest") promoteSpeakers(bot.room);
      } else if (msg?.t === "role" && msg.id === bot.id) {
        bot.role = msg.role;
        if (bot.part !== "guest") promoteSpeakers(bot.room);
      } else if (msg?.t === "chat" && msg.message.playerId === bot.id) {
        chat.add(Date.now() - Number(msg.message.text.split(" ")[1]));
      } else if (msg?.t === "correction") {
        bot.x = msg.x;
        bot.y = msg.y;
        counters.corrections++;
      } else if (msg?.t === "migrate") {
        void migrate(bot);
      }
    });
    ws.addEventListener("close", () => {
      if (bot.ws !== ws) return; // replaced on purpose
      bot.joined = false;
      counters.closes++;
      void rejoin(bot);
    });
    ws.addEventListener("error", () => counters.errors++);
  }

  /** The server shed load: like the client, get a ticket elsewhere and switch. */
  async function migrate(bot: Bot): Promise<void> {
    if (bot.switching || !bot.ticket) return;
    bot.switching = true;
    const placed = await place("/api/migrate", { ticket: bot.ticket });
    bot.switching = false;
    if (!placed) return;
    bot.ticket = placed.ticket;
    counters.migrations++;
    connect(bot, placed.url);
  }

  /** The socket dropped: rejoin the room through the agent, as the client does. */
  async function rejoin(bot: Bot): Promise<void> {
    if (bot.switching) return;
    bot.switching = true;
    const placed = await place("/api/join", { room: bot.room });
    bot.switching = false;
    if (!placed) return;
    bot.ticket = placed.ticket;
    counters.rejoins++;
    connect(bot, placed.url);
  }

  // ------------------------------------------------------------ voice

  /** Voice frames in a raw snapshot: after the players, a UInt8 count of {id, seq, len, data}. */
  function readVoice(data: DataView): void {
    let o = 3 + data.getUint16(1, true) * SNAPSHOT_ENTRY;
    const count = data.getUint8(o);
    o += 1;
    if (count === 0) return;
    const now = Date.now();
    const current = Math.floor((now - voiceEpoch) / VOICE_FRAME_MS);
    for (let i = 0; i < count; i++) {
      const seq = data.getUint16(o + 2, true);
      o += 6 + data.getUint16(o + 4, true);
      // Unwrap the 16-bit seq to the latest frame index with those low bits.
      const k = current - (((current & 0xffff) - seq + 0x10000) & 0xffff);
      voiceLatency.add(now - (voiceEpoch + (k + 1) * VOICE_FRAME_MS));
      counters.voiceRx++;
    }
  }

  function joinConversation(bot: Bot): void {
    let c = conversations.get(bot.room);
    if (!c) {
      c = { talkers: [], current: 0, speakFrom: 0, turnUntil: 0, overlap: null, lastFrame: -1 };
      conversations.set(bot.room, c);
    }
    // The host talks first.
    if (bot.part === "host") c.talkers.unshift(bot);
    else c.talkers.push(bot);
  }

  /** The room's host promotes its speakers (again, after one of them rejoined). */
  function promoteSpeakers(room: string): void {
    const c = conversations.get(room);
    const host = c?.talkers.find((b) => b.part === "host" && b.joined && b.role === "host");
    if (!c || !host) return;
    for (const b of c.talkers) {
      if (b.part !== "speaker" || !b.joined || b.role === "speaker") continue;
      host.ws.send(encodeClientMessage({ t: "set_role", id: b.id, role: "speaker" }));
    }
  }

  /** Who talks during the frame ending at `t` (ms). */
  function talkersAt(c: Conversation, t: number): number[] {
    const n = c.talkers.length;
    if (t >= c.turnUntil) {
      if (n > 1) c.current = (c.current + 1 + Math.floor(Math.random() * (n - 1))) % n;
      c.speakFrom = t + 300 + Math.random() * 700;
      const turn = 2000 + Math.random() * 4000;
      c.turnUntil = c.speakFrom + turn;
      c.overlap = null;
      if (n > 1 && Math.random() < 0.25) {
        const other = (c.current + 1 + Math.floor(Math.random() * (n - 1))) % n;
        const from = c.speakFrom + Math.random() * Math.max(0, turn - 1000);
        c.overlap = { talker: other, from, until: from + 800 + Math.random() * 1200 };
      }
    }
    const out: number[] = [];
    if (t >= c.speakFrom) out.push(c.current);
    if (c.overlap && t >= c.overlap.from && t < c.overlap.until) out.push(c.overlap.talker);
    return out;
  }

  /** Every 20 ms: send the frames that just ended, for every room's current talkers. */
  setInterval(() => {
    if (!voiceEpoch) return;
    const ended = Math.floor((Date.now() - voiceEpoch) / VOICE_FRAME_MS) - 1;
    for (const c of conversations.values()) {
      // After a stall, skip ahead instead of sending a burst of old frames.
      if (c.lastFrame < ended - 10) c.lastFrame = ended - 10;
      for (let k = c.lastFrame + 1; k <= ended; k++) {
        for (const i of talkersAt(c, voiceEpoch + (k + 1) * VOICE_FRAME_MS)) {
          const bot = c.talkers[i];
          if (!bot.joined || bot.role === "guest" || bot.ws.readyState !== WebSocket.OPEN) continue;
          const sample = voiceSample(bot.voice);
          const frame = encodeClientMessage({ t: "voice", seq: k & 0xffff, data: sample[bot.voicePos++ % sample.length] });
          bot.ws.send(frame);
          counters.bytesOut += frame.byteLength;
          voiceSent.set(bot.room, (voiceSent.get(bot.room) ?? 0) + 1);
        }
      }
      c.lastFrame = ended;
    }
  }, VOICE_FRAME_MS);

  // Each bot sends once per tick; bots are spread over 5 phases to avoid bursts.
  const PHASES = 5;
  const stepPx = MOVE_SPEED / TICK_RATE;
  let phase = 0;
  setInterval(() => {
    const now = Date.now();
    for (let i = phase; i < bots.length; i += PHASES) {
      const bot = bots[i];
      if (!bot.joined || bot.ws.readyState !== WebSocket.OPEN) continue;
      if (now >= bot.nextChat) {
        const chatFrame = encodeClientMessage({ t: "chat", text: `ping ${now}` });
        bot.ws.send(chatFrame);
        counters.bytesOut += chatFrame.byteLength;
        bot.nextChat = now + chatEveryMs * (0.5 + Math.random());
      }
      if (now >= bot.phaseUntil) {
        bot.walking = !bot.walking;
        bot.phaseUntil = now + (bot.walking ? walkMs() : idleMs(movingRatio));
        if (!bot.walking) {
          // Like the real client: one "stopped" update, then silence.
          const stop = encodeClientMessage({ t: "move", x: bot.x, y: bot.y, dir: DIRS[bot.heading].dir, moving: false });
          bot.ws.send(stop);
          counters.bytesOut += stop.byteLength;
        }
      }
      if (!bot.walking) continue;
      if (now >= bot.nextTurn) {
        bot.heading = Math.floor(Math.random() * DIRS.length);
        bot.nextTurn = now + 1000 + Math.random() * 2000;
      }
      const d = DIRS[bot.heading];
      let next = moveInSpace(bot.x, bot.y, d.dx * stepPx, d.dy * stepPx);
      const snapped = { x: quantize(next.x), y: quantize(next.y) };
      next = canBeAt(snapped.x, snapped.y) ? snapped : bot;
      if (next.x === bot.x && next.y === bot.y) bot.nextTurn = 0; // stuck: turn next tick
      bot.x = next.x;
      bot.y = next.y;
      const frame = encodeClientMessage({ t: "move", x: bot.x, y: bot.y, dir: d.dir, moving: true });
      bot.ws.send(frame);
      counters.bytesOut += frame.byteLength;
      bot.pending.push({ xw: toWire(bot.x), yw: toWire(bot.y), t: performance.now() });
      if (bot.pending.length > 20) bot.pending.shift(); // e.g. moves rejected by the server
    }
    phase = (phase + 1) % PHASES;
  }, 1000 / TICK_RATE / PHASES);

  setInterval(() => {
    const report: WorkerReport = {
      connected: bots.filter((b) => b.joined).length,
      ...counters,
      gaps: gaps.entries(),
      chat: chat.entries(),
      move: move.entries(),
      voiceSent: [...voiceSent],
      voice: voiceLatency.entries(),
    };
    // Workers talk to the orchestrator in JSON lines over stdio .
    process.stdout.write(JSON.stringify(report) + "\n");
    gaps = new Histogram();
    chat = new Histogram();
    move = new Histogram();
    voiceLatency = new Histogram();
    voiceSent = new Map();
    counters = newCounters();
  }, 1000);

  type Command =
    | { cmd: "config"; baseUrl: string; chatEveryMs: number; movingRatio: number; voiceEpoch: number }
    | { cmd: "add"; room: string; name: string; part?: Bot["part"]; hostKey?: string; voice?: number };
  createInterface({ input: process.stdin }).on("line", (line) => {
    const msg = JSON.parse(line) as Command;
    if (msg.cmd === "config") {
      baseUrl = msg.baseUrl;
      chatEveryMs = msg.chatEveryMs;
      movingRatio = msg.movingRatio;
      voiceEpoch = msg.voiceEpoch;
    } else {
      void addBot(msg.room, msg.name, msg.part ?? "guest", msg.hostKey ?? "", msg.voice ?? 0);
    }
  });
}

// ---------------------------------------------------------------- orchestrator

/** One second of server load, as served by the server's GET /api/health. */
interface StatsSample {
  t: number;
  rooms: number;
  players: number;
  cpu: number;
  loopP99Ms: number;
  tickP99Ms?: number;
  rssMb: number;
}

interface HealthReport {
  runtime?: string;
  now: number;
  /** Cluster agents only: every server's own view. */
  servers?: { server: number; alive: boolean; players: number; latest: StatsSample | null }[];
  latest: StatsSample | null;
  samples: StatsSample[];
}

const USAGE = `Usage: bun tools/loadtest.ts [options]   (or: bun run loadtest [options], not on Windows)

  --steps <n,n,...>    total bot counts to ramp through         (default 50,100,200)
  --room-size <n>      bots per room; 0 = everyone in one room   (default 0)
  --hold <s>           seconds at each step; 2nd half measured   (default 20)
  --ramp <n>           new connections per second                (default 100)
  --workers <n>        bot processes                             (default 6)
  --chat-every <s>     seconds between chat messages per bot; 0 = no chat (default 30)
  --speakers <n>       talkers per room: a host plus n-1 speakers holding a
                       conversation (real Opus frames); rooms are created with
                       POST /api/rooms and printed as invite links (default 0)
  --moving <0..1>      share of time each bot spends walking; the rest it stands
                       still and sends nothing (default 1 = everyone always walking)
  --target <url>       test a running server instead of spawning one,
                       e.g. https://meet.example.com
  --health-token <s>   token for the server's /api/health, if it sets HEALTH_TOKEN
  --cluster <n>        spawn a local cluster (agent + n servers) instead of one server
  --capacity <n>       players per server for --cluster          (default 2000)
  --port <n>           port for the spawned server or agent      (default 3300)
  --room-prefix <s>    rooms are <prefix>-all or <prefix>-0, -1, ... (default load;
                       not used with --speakers)
  --keep-going         continue ramping after a failed step
  --last               reuse the options of the previous run; options given with it
                       override them, e.g. --last --hold 60
  -h, --help           show this help`;

/** Options of the last successful parse, for --last. Git-ignored. */
const LAST_FILE = resolve(ROOT, ".loadtest-last.json");

interface Options {
  steps: number[];
  roomSize: number;
  hold: number;
  ramp: number;
  workers: number;
  chatEveryMs: number;
  movingRatio: number;
  speakers: number;
  port: number;
  /** Game servers in a spawned local cluster; 0 = one standalone server. */
  cluster: number;
  capacity: number;
  roomPrefix: string;
  keepGoing: boolean;
  healthToken: string;
  /** Remote server, or null to spawn a local one. */
  target: { ws: string; http: string } | null;
}

function fail(message: string): never {
  console.error(`loadtest: ${message}\n\n${USAGE}`);
  process.exit(2);
}

/** Command line for display, with the health token masked. */
function describe(argv: string[]): string {
  return argv
    .map((a, i) => (argv[i - 1] === "--health-token" ? "***" : a.replace(/^(--health-token=).*/, "$1***")))
    .join(" ");
}

function parseOptions(): Options {
  let argv = process.argv.slice(2);
  const hadOptions = argv.length > 0;
  if (argv.includes("--last")) {
    let saved: unknown;
    try {
      // Tolerate a UTF-8 BOM (files copied through some Windows editors).
      saved = JSON.parse(readFileSync(LAST_FILE, "utf8").replace(/^\uFEFF/, "")).argv;
    } catch {
      fail(`--last: no saved options in ${LAST_FILE}`);
    }
    if (!Array.isArray(saved) || saved.length === 0 || !saved.every((a) => typeof a === "string")) {
      fail(`--last: ${LAST_FILE} holds no options (expected {"argv": ["--steps", "…", …]})`);
    }
    console.log(`Options from ${LAST_FILE}`);
    // Later occurrences win in parseArgs, so explicit options override the saved ones.
    argv = [...saved, ...argv.filter((a) => a !== "--last")];
  }

  let values;
  let tokens;
  try {
    ({ values, tokens } = parseArgs({
      args: argv,
      tokens: true,
      strict: true,
      allowPositionals: false,
      options: {
        steps: { type: "string", default: "50,100,200" },
        "room-size": { type: "string", default: "0" },
        hold: { type: "string", default: "20" },
        ramp: { type: "string", default: "100" },
        workers: { type: "string", default: "6" },
        "chat-every": { type: "string", default: "30" },
        speakers: { type: "string", default: "0" },
        moving: { type: "string", default: "1" },
        target: { type: "string" },
        "health-token": { type: "string", default: "" },
        port: { type: "string", default: "3300" },
        cluster: { type: "string", default: "0" },
        capacity: { type: "string", default: "2000" },
        "room-prefix": { type: "string", default: "load" },
        "keep-going": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    const message = (err as Error).message;
    // Windows: "bun run loadtest --opt value" can reach us as just "value".
    const hint = /Unexpected argument/.test(message)
      ? `\nIf you used "bun run loadtest …" (notably on Windows), run "bun tools/loadtest.ts …" instead; Bun's script shell can drop flags.`
      : "";
    fail(message + hint);
  }
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  // Canonical form: each given option once, with its final value.
  const given = new Map<string, string | undefined>();
  for (const t of tokens) if (t.kind === "option") given.set(t.name, t.value);
  const reusedLast = process.argv.includes("--last");
  argv = [...given].flatMap(([name, value]) => (value === undefined ? [`--${name}`] : [`--${name}`, value]));
  console.log(`${reusedLast ? "Re-running" : "Running"}: bun tools/loadtest.ts ${describe(argv) || "(defaults)"}`);

  const int = (name: string, raw: string, min: number): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) fail(`--${name} must be an integer >= ${min}, got "${raw}"`);
    return n;
  };
  const ratio = (name: string, raw: string): number => {
    const n = Number(raw);
    if (raw.trim() === "" || !(n >= 0 && n <= 1)) fail(`--${name} must be a number from 0 to 1, got "${raw}"`);
    return n;
  };
  const steps = values.steps.split(",").map((s) => int("steps", s.trim(), 1));
  if (steps.some((n, i) => i > 0 && n <= steps[i - 1])) fail("--steps must be increasing");
  if (!ROOM_ID_PATTERN.test(`${values["room-prefix"]}-all`)) fail("--room-prefix may only use a-z, 0-9 and -");
  if (values.target !== undefined && Number(values.cluster) > 0) fail("--cluster spawns a local cluster; it cannot be combined with --target");

  const options: Options = {
    steps,
    roomSize: int("room-size", values["room-size"], 0),
    hold: int("hold", values.hold, 2),
    ramp: int("ramp", values.ramp, 1),
    workers: int("workers", values.workers, 1),
    chatEveryMs: int("chat-every", values["chat-every"], 0) * 1000,
    movingRatio: ratio("moving", values.moving),
    speakers: int("speakers", values.speakers, 0),
    port: int("port", values.port, 1),
    cluster: int("cluster", values.cluster, 0),
    capacity: int("capacity", values.capacity, 1),
    roomPrefix: values["room-prefix"],
    keepGoing: values["keep-going"],
    healthToken: values["health-token"],
    target: values.target === undefined ? null : parseTarget(values.target),
  };
  if (options.speakers > MAX_SPEAKERS + 1) fail(`--speakers is at most ${MAX_SPEAKERS + 1} (the host plus ${MAX_SPEAKERS})`);
  const perRoom = options.roomSize > 0 ? options.roomSize : Infinity;
  if (options.speakers > Math.min(perRoom, options.steps[0])) fail("--speakers must fit in a room and in the first step");
  // The server keeps 5 minutes of samples; a longer window would be cut short.
  if (options.hold / 2 > 290) fail("--hold must be at most 580 seconds");

  // A bare run (no options) keeps the saved ones instead of erasing them.
  if (hadOptions) writeFileSync(LAST_FILE, JSON.stringify({ argv, savedAt: new Date().toISOString() }, null, 2) + "\n");
  return options;
}

/** Accepts http(s):// or ws(s):// URLs; any path (e.g. a room link) is ignored. */
function parseTarget(raw: string): { ws: string; http: string } {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    fail(`--target is not a valid URL: "${raw}"`);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) fail(`--target must be http(s) or ws(s), got ${url.protocol}`);
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  return {
    ws: `${secure ? "wss" : "ws"}://${url.host}${WS_PATH}`,
    http: `${secure ? "https" : "http"}://${url.host}`,
  };
}

class HealthError extends Error {}

/** Reads the server's GET /api/health. */
class HealthClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(baseUrl: string, token: string) {
    this.url = `${baseUrl}/api/health`;
    this.headers = token ? { authorization: `Bearer ${token}` } : {};
  }

  async fetch(since = 0): Promise<HealthReport> {
    let res: Response;
    try {
      res = await fetch(`${this.url}?since=${since}`, { headers: this.headers, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw new HealthError(`${this.url} is not reachable: ${(err as Error).message}`);
    }
    if (res.status === 401) throw new HealthError(`${this.url} needs a token: pass --health-token (server HEALTH_TOKEN)`);
    if (!res.ok) throw new HealthError(`${this.url} returned HTTP ${res.status}`);
    return (await res.json()) as HealthReport;
  }

  /** Poll until the server answers (a freshly spawned one needs a moment). */
  async waitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.fetch(Date.now());
        return;
      } catch (err) {
        if (Date.now() > deadline || !(err as Error).message.includes("not reachable")) throw err;
        await sleep(250);
      }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send a command line to a worker's stdin. */
function tell(worker: ChildProcess, msg: object): void {
  worker.stdin!.write(JSON.stringify(msg) + "\n");
}

/** The load test runs on Bun; the spawned server and the bot workers use the same binary. */
const BUN = process.execPath;

async function runOrchestrator(): Promise<void> {
  const opts = parseOptions();
  const { steps, roomSize, hold, ramp, chatEveryMs, roomPrefix, speakers } = opts;
  const workerCount = opts.workers;

  // Either spawn a local server or use the remote one; both report through /api/health.
  let server: ChildProcess | null = null;
  /** GC pauses parsed from a spawned Bun server's BUN_JSC_logGC output. */
  const gcEvents: { t: number; pauseMs: number; full: boolean }[] = [];
  let wsUrl: string;
  let httpUrl: string;
  if (opts.target) {
    ({ ws: wsUrl, http: httpUrl } = opts.target);
  } else {
    wsUrl = `ws://127.0.0.1:${opts.port}${WS_PATH}`;
    httpUrl = `http://127.0.0.1:${opts.port}`;
    // The supervisor runs one standalone server, or the agent plus --cluster servers.
    server = spawn(BUN, ["server/src/supervisor.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(opts.port),
        HOST: "0.0.0.0",
        HEALTH_TOKEN: opts.healthToken,
        NODE_ENV: "production",
        CLUSTER_SERVERS: String(opts.cluster),
        SERVER_CAPACITY: String(opts.capacity),
        // JavaScriptCore prints one line per collection with its pause ("p=<ms>").
        BUN_JSC_logGC: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    createInterface({ input: server.stderr! }).on("line", (line) => {
      const gc = line.match(/=> (Eden|Full)Collection.*\bp=([\d.]+)ms/);
      if (gc) gcEvents.push({ t: Date.now(), pauseMs: Number(gc[2]), full: gc[1] === "Full" });
      else if (!/(\[GC<|GC END!|Requesting GC)/.test(line)) process.stderr.write(line + "\n");
    });
  }
  const health = new HealthClient(httpUrl, opts.healthToken);
  let runtimeLabel = "unknown runtime";
  /** A protected remote server without --health-token: run on the bots' own measurements. */
  let noServerStats = false;
  try {
    await health.waitReady(opts.target ? 0 : 60_000);
    runtimeLabel = (await health.fetch(Date.now())).runtime ?? runtimeLabel;
  } catch (err) {
    if (opts.target && !opts.healthToken && (err as Error).message.includes("needs a token")) {
      noServerStats = true;
      console.warn(`${(err as Error).message}; continuing without server columns`);
    } else {
      server?.kill();
      fail((err as Error).message);
    }
  }
  console.log(opts.target ? `Target ${wsUrl} (${runtimeLabel})` : `Spawned ${runtimeLabel} server on port ${opts.port}`);
  console.log(`Bots walk ${Math.round(opts.movingRatio * 100)}% of the time${chatEveryMs ? "" : ", no chat"}`);

  // With --speakers the server creates the rooms, and hands out their host keys.
  const roomCount = roomSize > 0 ? Math.ceil(steps.at(-1)! / roomSize) : 1;
  const created: { room: string; hostKey: string }[] = [];
  if (speakers > 0) {
    for (let i = 0; i < roomCount; i++) {
      const res = await fetch(`${httpUrl}/api/rooms`, { method: "POST" }).catch(() => null);
      if (!res?.ok) {
        server?.kill();
        fail(`${httpUrl}/api/rooms failed (${res?.status ?? "unreachable"}); --speakers needs a server with roles`);
      }
      created.push((await res.json()) as { room: string; hostKey: string });
    }
    console.log(`Each room: a host + ${speakers - 1} speaker(s) talking in turns; the rest listen`);
    const shown = created.slice(0, 3).map((c) => `${httpUrl}/r/${c.room}`);
    console.log(`Invite link${created.length > 1 ? "s" : ""}: ${shown.join("  ")}${created.length > 3 ? `  (+${created.length - 3} more)` : ""}`);
  } else {
    console.log(`Rooms: /r/${roomSize > 0 ? `${roomPrefix}-0 .. ${roomPrefix}-${roomCount - 1}` : `${roomPrefix}-all`}`);
  }

  const workers: ChildProcess[] = [];
  let window: WorkerReport[] = [];
  const connected = new Map<ChildProcess, number>();
  for (let i = 0; i < workerCount; i++) {
    const w = spawn(BUN, [import.meta.filename, "--worker"], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: w.stdout! }).on("line", (line) => {
      if (!line.startsWith("{")) return;
      const r = JSON.parse(line) as WorkerReport;
      window.push(r);
      connected.set(w, r.connected);
    });
    workers.push(w);
  }
  const voiceEpoch = Date.now();
  for (const w of workers) tell(w, { cmd: "config", baseUrl: httpUrl, chatEveryMs, movingRatio: opts.movingRatio, voiceEpoch });

  const roomIndex = (i: number) => (roomSize > 0 ? Math.floor(i / roomSize) : 0);
  const roomFor = (i: number) =>
    speakers > 0 ? created[roomIndex(i)].room : roomSize > 0 ? `${roomPrefix}-${roomIndex(i)}` : `${roomPrefix}-all`;
  /** Bots sent to each room so far: every voice frame should reach all of them. */
  const members = new Map<string, number>();
  /** Bot `i`: its part, and the worker it goes to (a room's talkers share one, so the host can promote them). */
  const assign = (i: number) => {
    const r = roomIndex(i);
    const seat = roomSize > 0 ? i % roomSize : i;
    if (seat >= speakers) return { worker: workers[i % workerCount], cmd: { cmd: "add", room: roomFor(i), name: `Guest ${i}` } };
    const part = seat === 0 ? "host" : "speaker";
    return {
      worker: workers[r % workerCount],
      cmd: {
        cmd: "add",
        room: roomFor(i),
        name: part === "host" ? "Host" : `Speaker ${seat}`,
        part,
        hostKey: part === "host" ? created[r].hostKey : "",
        voice: seat,
      },
    };
  };
  let total = 0;
  console.log(
    "bots | rooms | srv players | srv CPU | loop p99 | tick p99 | gc/s | gc max ms | RSS MB | move p50/p99 ms | snap gap p50/p99/max ms | chat p50/p99 ms | voice p50/p99 ms | voice rx | in MB/s | corr | drops | migr | rejoin | verdict",
  );

  for (const target of steps) {
    // Ramp up at a fixed connection rate.
    while (total < target) {
      const batch = Math.min(target - total, Math.max(1, Math.round(ramp / 10)));
      for (let i = 0; i < batch; i++, total++) {
        const { worker, cmd } = assign(total);
        tell(worker, cmd);
        members.set(cmd.room, (members.get(cmd.room) ?? 0) + 1);
      }
      await sleep(100);
    }
    await sleep((hold / 2) * 1000);

    // Measure the second half of the hold: bot reports plus the server's own samples.
    window = [];
    let serverFrom: number | null = null;
    let healthProblem = "";
    if (!noServerStats) {
      try {
        serverFrom = (await health.fetch(Date.now())).now;
      } catch (err) {
        healthProblem = (err as Error).message;
      }
    }
    const t0 = Date.now();
    await sleep((hold / 2) * 1000);
    const t1 = Date.now();
    const elapsed = (t1 - t0) / 1000;
    let samples: StatsSample[] = [];
    let latest: StatsSample | null = null;
    let perServer: HealthReport["servers"];
    if (serverFrom !== null) {
      try {
        const report = await health.fetch(serverFrom);
        samples = report.samples;
        latest = report.latest;
        perServer = report.servers;
      } catch (err) {
        healthProblem = (err as Error).message;
      }
    }
    if (healthProblem) console.warn(`  (server stats unavailable: ${healthProblem})`);

    const gaps = new Histogram();
    const chat = new Histogram();
    const move = new Histogram();
    const voice = new Histogram();
    let voiceRx = 0;
    let voiceExpected = 0;
    let bytesIn = 0;
    let corrections = 0;
    let drops = 0;
    let socketErrors = 0;
    let migrations = 0;
    let rejoins = 0;
    for (const r of window) {
      migrations += r.migrations;
      rejoins += r.rejoins;
      gaps.merge(r.gaps);
      chat.merge(r.chat);
      move.merge(r.move);
      voice.merge(r.voice);
      voiceRx += r.voiceRx;
      for (const [room, n] of r.voiceSent) voiceExpected += n * (members.get(room) ?? 0);
      bytesIn += r.bytesIn;
      corrections += r.corrections;
      drops += r.closes;
      socketErrors += r.errors;
    }
    const joined = [...connected.values()].reduce((a, b) => a + b, 0);
    const mean = (key: keyof StatsSample) => samples.reduce((a, s) => a + (s[key] ?? 0), 0) / samples.length;
    const have = samples.length > 0;
    const cpu = have ? mean("cpu") : NaN;
    const loopP99 = have ? Math.max(...samples.map((s) => s.loopP99Ms)) : NaN;
    const tickP99 = have && samples[0].tickP99Ms !== undefined ? Math.max(...samples.map((s) => s.tickP99Ms ?? 0)) : NaN;
    // GC comes from the spawned server's BUN_JSC_logGC output; unknown for --target.
    const gcWindow = gcEvents.filter((e) => e.t >= t0 && e.t <= t1);
    const gcPerSec = server ? gcWindow.length / elapsed : NaN;
    const gcMax = gcWindow.length ? Math.max(...gcWindow.map((e) => e.pauseMs)) : server ? 0 : NaN;
    const show = (v: number, text: () => string) => (Number.isNaN(v) ? "-" : text());

    const gapP99 = gaps.percentile(0.99);
    const chatP99 = chat.percentile(0.99);
    const problems = [];
    if (joined < target) problems.push(`only ${joined} joined`);
    const moveP99 = move.percentile(0.99);
    if (move.total > 0 && moveP99 > 150) problems.push("moves slow");
    // With idle bots, long snapshot gaps are expected (nothing to send), so only judge them when all walk.
    if (opts.movingRatio >= 1 && !(gapP99 <= 100)) problems.push("snapshots late");
    if (chat.total > 0 && chatP99 > 250) problems.push("chat slow");
    const voiceP99 = voice.percentile(0.99);
    const voiceShare = voiceExpected > 0 ? voiceRx / voiceExpected : NaN;
    if (voice.total > 0 && voiceP99 > 300) problems.push("voice slow");
    if (voiceShare < 0.97) problems.push("voice lost");
    if (drops > 0) problems.push("disconnects");
    if (socketErrors > 0) problems.push(`${socketErrors} socket errors`);
    if (loopP99 > 50) problems.push("event loop lag");
    const verdict = problems.length ? `FAIL (${problems.join(", ")})` : "ok";

    const row = [
      String(target).padStart(4),
      String(roomSize > 0 ? Math.ceil(target / roomSize) : 1).padStart(5),
      String(latest?.players ?? "-").padStart(11),
      show(cpu, () => `${(cpu * 100).toFixed(0)}%`).padStart(7),
      show(loopP99, () => loopP99.toFixed(1)).padStart(8),
      show(tickP99, () => tickP99.toFixed(2)).padStart(8),
      show(gcPerSec, () => gcPerSec.toFixed(1)).padStart(4),
      show(gcMax, () => gcMax.toFixed(1)).padStart(9),
      String(latest?.rssMb ?? "-").padStart(6),
      (move.total ? `${move.percentile(0.5)}/${moveP99}` : "-").padStart(15),
      `${gaps.percentile(0.5)}/${gapP99}/${gaps.percentile(1)}`.padStart(23),
      (chat.total ? `${chat.percentile(0.5)}/${chatP99}` : "-").padStart(15),
      (voice.total ? `${voice.percentile(0.5)}/${voiceP99}` : "-").padStart(16),
      show(voiceShare, () => `${Math.min(100, voiceShare * 100).toFixed(1)}%`).padStart(8),
      (bytesIn / elapsed / 1e6).toFixed(1).padStart(7),
      String(corrections).padStart(4),
      String(drops).padStart(5),
      String(migrations).padStart(4),
      String(rejoins).padStart(6),
      verdict,
    ].join(" | ");
    console.log(row);
    if (perServer?.length) {
      const parts = perServer
        .sort((a, b) => a.server - b.server)
        .map((s) =>
          s.alive && s.latest
            ? `s${s.server} ${s.players}p ${(s.latest.cpu * 100).toFixed(0)}% cpu loop ${s.latest.loopP99Ms}ms`
            : `s${s.server} down`,
        );
      console.log(`       ${parts.join(" | ")}`);
    }
    if (problems.length && !opts.keepGoing) break;
  }

  for (const w of workers) w.kill();
  server?.kill();
  process.exit(0);
}

if (process.argv.includes("--worker")) runWorker();
else runOrchestrator();
