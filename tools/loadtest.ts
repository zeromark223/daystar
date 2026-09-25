/**
 * Load test: ramps up bot players in steps and reports whether each step
 * stays healthy. Bots join, walk non-stop (worst case: everyone moving) using
 * the real collision map, send positions at the client rate and chat now and then.
 *
 *   npm run loadtest -- --steps 100,200,400 --room-size 20
 *   npm run loadtest -- --target https://meet.example.com --steps 200,500
 *
 * Run with --help for the options (USAGE below).
 */
import { fork, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import WebSocket from "ws";
import { CHARACTER_IDS, collisionOffsetY, type CharacterId, type Direction } from "../shared/src/characters.ts";
import { CollisionMap } from "../shared/src/collision.ts";
import { MOVE_SPEED, ROOM_ID_PATTERN, TICK_RATE, WS_PATH } from "../shared/src/constants.ts";
import { decodeServerMessage, encodeClientMessage, quantize, SNAPSHOT_OPCODE } from "../shared/src/protocol.ts";

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
  corrections: number;
  closes: number;
  errors: number;
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
  character: CharacterId;
  id: number;
  x: number;
  y: number;
  heading: number;
  nextTurn: number;
  nextChat: number;
  lastSnapshot: number;
  joined: boolean;
}

function runWorker(): void {
  const map = CollisionMap.parse(readFileSync(resolve(ROOT, "client/public/assets/collision.txt"), "utf8"));
  const bots: Bot[] = [];
  let url = "";
  let chatEveryMs = 30_000;
  let gaps = new Histogram();
  let chat = new Histogram();
  let counters = { snapshots: 0, bytesIn: 0, bytesOut: 0, corrections: 0, closes: 0, errors: 0 };

  function addBot(room: string): void {
    const ws = new WebSocket(`${url}?room=${room}`);
    const character = CHARACTER_IDS[Math.floor(Math.random() * CHARACTER_IDS.length)];
    const bot: Bot = {
      ws,
      character,
      id: -1,
      x: 0,
      y: 0,
      heading: Math.floor(Math.random() * DIRS.length),
      nextTurn: 0,
      nextChat: Date.now() + Math.random() * chatEveryMs,
      lastSnapshot: 0,
      joined: false,
    };
    ws.on("open", () => ws.send(encodeClientMessage({ t: "join", name: `bot${bots.length}`, character })));
    ws.on("message", (data: Buffer) => {
      counters.bytesIn += data.length;
      const now = performance.now();
      // Snapshots are only counted, not decoded, to keep bots cheap.
      if (data[0] === SNAPSHOT_OPCODE) {
        counters.snapshots++;
        if (bot.lastSnapshot) gaps.add(now - bot.lastSnapshot);
        bot.lastSnapshot = now;
        return;
      }
      const msg = decodeServerMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      if (msg?.t === "welcome") {
        const self = msg.players.find((p) => p.id === msg.selfId)!;
        bot.id = msg.selfId;
        bot.x = self.x;
        bot.y = self.y;
        bot.joined = true;
      } else if (msg?.t === "chat" && msg.message.playerId === bot.id) {
        chat.add(Date.now() - Number(msg.message.text.split(" ")[1]));
      } else if (msg?.t === "correction") {
        bot.x = msg.x;
        bot.y = msg.y;
        counters.corrections++;
      }
    });
    ws.on("close", () => {
      if (bot.joined) counters.closes++;
      bot.joined = false;
    });
    ws.on("error", () => counters.errors++);
    bots.push(bot);
  }

  // Each bot sends once per tick; bots are spread over 5 phases to avoid bursts.
  const PHASES = 5;
  const stepPx = MOVE_SPEED / TICK_RATE;
  let phase = 0;
  setInterval(() => {
    const now = Date.now();
    for (let i = phase; i < bots.length; i += PHASES) {
      const bot = bots[i];
      if (!bot.joined || bot.ws.readyState !== WebSocket.OPEN) continue;
      if (now >= bot.nextTurn) {
        bot.heading = Math.floor(Math.random() * DIRS.length);
        bot.nextTurn = now + 1000 + Math.random() * 2000;
      }
      const d = DIRS[bot.heading];
      const offset = collisionOffsetY(bot.character);
      let next = map.moveWithCollision(bot.x, bot.y, d.dx * stepPx, d.dy * stepPx, offset);
      const snapped = { x: quantize(next.x), y: quantize(next.y) };
      next = map.canStandAt(snapped.x, snapped.y, offset) ? snapped : bot;
      if (next.x === bot.x && next.y === bot.y) bot.nextTurn = 0; // stuck: turn next tick
      bot.x = next.x;
      bot.y = next.y;
      const move = encodeClientMessage({ t: "move", x: bot.x, y: bot.y, dir: d.dir, moving: true });
      bot.ws.send(move);
      counters.bytesOut += move.byteLength;
      if (now >= bot.nextChat) {
        const chatFrame = encodeClientMessage({ t: "chat", text: `ping ${now}` });
        bot.ws.send(chatFrame);
        counters.bytesOut += chatFrame.byteLength;
        bot.nextChat = now + chatEveryMs * (0.5 + Math.random());
      }
    }
    phase = (phase + 1) % PHASES;
  }, 1000 / TICK_RATE / PHASES);

  setInterval(() => {
    const report: WorkerReport = {
      connected: bots.filter((b) => b.joined).length,
      ...counters,
      gaps: gaps.entries(),
      chat: chat.entries(),
    };
    process.send!(report);
    gaps = new Histogram();
    chat = new Histogram();
    counters = { snapshots: 0, bytesIn: 0, bytesOut: 0, corrections: 0, closes: 0, errors: 0 };
  }, 1000);

  process.on("message", (msg: { cmd: "config"; url: string; chatEveryMs: number } | { cmd: "add"; room: string }) => {
    if (msg.cmd === "config") {
      url = msg.url;
      chatEveryMs = msg.chatEveryMs;
    } else {
      addBot(msg.room);
    }
  });
}

// ---------------------------------------------------------------- orchestrator

interface ServerStats {
  rooms: number;
  players: number;
  elu: number;
  loopP99Ms: number;
  loopMaxMs: number;
  rssMb: number;
}

const USAGE = `Usage: npm run loadtest -- [options]

  --steps <n,n,...>   total bot counts to ramp through         (default 50,100,200)
  --room-size <n>     bots per room; 0 = everyone in one room   (default 0)
  --hold <s>          seconds at each step; 2nd half measured   (default 20)
  --ramp <n>          new connections per second                (default 100)
  --workers <n>       bot processes                             (default 6)
  --chat-every <s>    seconds between chat messages per bot     (default 30)
  --target <url>      test a running server instead of spawning one,
                      e.g. https://meet.example.com (server CPU/loop columns show "-")
  --port <n>          port for the spawned server               (default 3300)
  --room-prefix <s>   rooms are <prefix>-all or <prefix>-0, -1, ... (default load)
  --keep-going        continue ramping after a failed step
  -h, --help          show this help`;

interface Options {
  steps: number[];
  roomSize: number;
  hold: number;
  ramp: number;
  workers: number;
  chatEveryMs: number;
  port: number;
  roomPrefix: string;
  keepGoing: boolean;
  /** WebSocket URL of a remote server, or null to spawn a local one. */
  target: { ws: string; http: string } | null;
}

const OPTION_NAMES = ["steps", "room-size", "hold", "ramp", "workers", "chat-every", "target", "port", "room-prefix", "keep-going"];

function fail(message: string): never {
  console.error(`loadtest: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseOptions(): Options {
  // `npm run loadtest --steps 5` (no "--") makes npm eat the flags and only
  // leave npm_config_* variables behind; refuse instead of silently using defaults.
  const swallowed = OPTION_NAMES.filter(
    (n) =>
      process.env[`npm_config_${n.replace(/-/g, "_")}`] !== undefined &&
      !process.argv.some((a) => a === `--${n}` || a.startsWith(`--${n}=`)),
  );
  if (swallowed.length > 0) {
    fail(`npm consumed --${swallowed.join(", --")}. Put "--" before the options: npm run loadtest -- --steps 100`);
  }

  let values;
  try {
    ({ values } = parseArgs({
      strict: true,
      allowPositionals: false,
      options: {
        steps: { type: "string", default: "50,100,200" },
        "room-size": { type: "string", default: "0" },
        hold: { type: "string", default: "20" },
        ramp: { type: "string", default: "100" },
        workers: { type: "string", default: "6" },
        "chat-every": { type: "string", default: "30" },
        target: { type: "string" },
        port: { type: "string", default: "3300" },
        "room-prefix": { type: "string", default: "load" },
        "keep-going": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    fail((err as Error).message);
  }
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const int = (name: string, raw: string, min: number): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) fail(`--${name} must be an integer >= ${min}, got "${raw}"`);
    return n;
  };
  const steps = values.steps.split(",").map((s) => int("steps", s.trim(), 1));
  if (steps.some((n, i) => i > 0 && n <= steps[i - 1])) fail("--steps must be increasing");
  if (!ROOM_ID_PATTERN.test(`${values["room-prefix"]}-all`)) fail("--room-prefix may only use a-z, 0-9 and -");

  return {
    steps,
    roomSize: int("room-size", values["room-size"], 0),
    hold: int("hold", values.hold, 2),
    ramp: int("ramp", values.ramp, 1),
    workers: int("workers", values.workers, 1),
    chatEveryMs: int("chat-every", values["chat-every"], 1) * 1000,
    port: int("port", values.port, 1),
    roomPrefix: values["room-prefix"],
    keepGoing: values["keep-going"],
    target: values.target === undefined ? null : parseTarget(values.target),
  };
}

/** Accepts http(s):// or ws(s):// URLs; any path (e.g. a room link) is ignored. */
function parseTarget(raw: string): { ws: string; http: string } {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    fail(`--target is not a valid URL: "${raw}"`);
  }
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) fail(`--target must be http(s) or ws(s), got ${url.protocol}`);
  return {
    ws: `${secure ? "wss" : "ws"}://${url.host}${WS_PATH}`,
    http: `${secure ? "https" : "http"}://${url.host}`,
  };
}

/** CPU seconds (user + system) consumed so far by a process. */
function cpuSeconds(pid: number): number {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  return (Number(fields[11]) + Number(fields[12])) / 100;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOrchestrator(): Promise<void> {
  const opts = parseOptions();
  const { steps, roomSize, hold, ramp, chatEveryMs, roomPrefix } = opts;
  const workerCount = opts.workers;

  // Either spawn a local server (with stats) or check that the remote one is up.
  let server: ChildProcess | null = null;
  let serverStats: ServerStats[] = [];
  let wsUrl: string;
  if (opts.target) {
    wsUrl = opts.target.ws;
    try {
      const res = await fetch(`${opts.target.http}/healthz`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      fail(`${opts.target.http}/healthz is not reachable: ${(err as Error).message}`);
    }
    console.log(`Target ${wsUrl} (server-side columns are not available for remote targets)`);
  } else {
    wsUrl = `ws://127.0.0.1:${opts.port}${WS_PATH}`;
    server = spawn(process.execPath, ["server/src/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(opts.port), HOST: "0.0.0.0", LOG_STATS: "1", NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    server.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.startsWith('{"stats"')) serverStats.push(JSON.parse(line));
      }
    });
    await sleep(1000);
    console.log(`Spawned server on port ${opts.port}, rooms /r/${roomPrefix}-...`);
  }

  const workers: ChildProcess[] = [];
  let window: WorkerReport[] = [];
  let connected = new Map<ChildProcess, number>();
  for (let i = 0; i < workerCount; i++) {
    const w = fork(import.meta.filename, ["--worker"], { stdio: "inherit" });
    w.send({ cmd: "config", url: wsUrl, chatEveryMs });
    w.on("message", (r: WorkerReport) => {
      window.push(r);
      connected.set(w, r.connected);
    });
    workers.push(w);
  }

  const roomFor = (i: number) => (roomSize > 0 ? `${roomPrefix}-${Math.floor(i / roomSize)}` : `${roomPrefix}-all`);
  let total = 0;
  const header =
    "bots | rooms | srv CPU | ELU  | loop p99 | RSS MB | snap gap p50/p99/max ms | chat p50/p99 ms | in MB/s | corr | drops | verdict";
  console.log(header);

  for (const target of steps) {
    // Ramp up at a fixed connection rate.
    while (total < target) {
      const batch = Math.min(target - total, Math.max(1, Math.round(ramp / 10)));
      for (let i = 0; i < batch; i++, total++) workers[total % workerCount].send({ cmd: "add", room: roomFor(total) });
      await sleep(100);
    }
    await sleep((hold / 2) * 1000);

    // Measure the second half of the hold.
    window = [];
    serverStats = [];
    const cpuStart = server ? cpuSeconds(server.pid!) : 0;
    const t0 = Date.now();
    await sleep((hold / 2) * 1000);
    const elapsed = (Date.now() - t0) / 1000;
    const cpu = server ? (cpuSeconds(server.pid!) - cpuStart) / elapsed : NaN;

    const gaps = new Histogram();
    const chat = new Histogram();
    let bytesIn = 0;
    let corrections = 0;
    let drops = 0;
    let socketErrors = 0;
    for (const r of window) {
      socketErrors += r.errors;
      gaps.merge(r.gaps);
      chat.merge(r.chat);
      bytesIn += r.bytesIn;
      corrections += r.corrections;
      drops += r.closes;
    }
    const joined = [...connected.values()].reduce((a, b) => a + b, 0);
    const avg = (key: keyof ServerStats) => serverStats.reduce((a, s) => a + s[key], 0) / (serverStats.length || 1);
    const loopP99 = serverStats.length ? Math.max(...serverStats.map((s) => s.loopP99Ms)) : NaN;
    const last = serverStats.at(-1);
    const rooms = roomSize > 0 ? Math.ceil(target / roomSize) : 1;
    const show = (v: number, text: string) => (Number.isNaN(v) ? "-" : text);

    const gapP99 = gaps.percentile(0.99);
    const chatP99 = chat.percentile(0.99);
    const problems = [];
    if (joined < target) problems.push(`only ${joined} joined`);
    if (!(gapP99 <= 100)) problems.push("snapshots late");
    if (chat.total > 0 && chatP99 > 250) problems.push("chat slow");
    if (drops > 0) problems.push("disconnects");
    if (socketErrors > 0) problems.push(`${socketErrors} socket errors`);
    if (loopP99 > 50) problems.push("event loop lag");
    const verdict = problems.length ? `FAIL (${problems.join(", ")})` : "ok";

    const row = [
      String(target).padStart(4),
      String(rooms).padStart(5),
      show(cpu, `${(cpu * 100).toFixed(0)}%`).padStart(7),
      show(loopP99, avg("elu").toFixed(2)).padStart(4),
      show(loopP99, loopP99.toFixed(1)).padStart(8),
      String(last?.rssMb ?? "-").padStart(6),
      `${gaps.percentile(0.5)}/${gapP99}/${gaps.percentile(1)}`.padStart(23),
      `${chat.percentile(0.5)}/${chatP99}`.padStart(15),
      (bytesIn / elapsed / 1e6).toFixed(1).padStart(7),
      String(corrections).padStart(4),
      String(drops).padStart(5),
      verdict,
    ].join(" | ");
    console.log(row);
    if (problems.length && !opts.keepGoing) break;
  }

  for (const w of workers) w.kill();
  server?.kill();
  process.exit(0);
}

if (process.argv.includes("--worker")) runWorker();
else runOrchestrator();
