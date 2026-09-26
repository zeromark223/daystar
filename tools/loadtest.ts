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
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import WebSocket from "ws";
import { CHARACTER_IDS, collisionOffsetY, type CharacterId, type Direction } from "../shared/src/characters.ts";
import { CollisionMap } from "../shared/src/collision.ts";
import { MOVE_SPEED, ROOM_ID_PATTERN, TICK_RATE, WS_PATH } from "../shared/src/constants.ts";
import {
  decodeServerMessage,
  encodeClientMessage,
  POSITION_SCALE,
  quantize,
  SNAPSHOT_OPCODE,
} from "../shared/src/protocol.ts";

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
  /** Walking or standing, and until when (see --moving). */
  walking: boolean;
  phaseUntil: number;
  /** Recently sent positions (wire units) awaiting their echo in a snapshot. */
  pending: { xw: number; yw: number; t: number }[];
}

/** Snapshot body: UInt16 count, then per player id, x, y (UInt16 LE) and motion (UInt8). */
const SNAPSHOT_ENTRY = 7;

/** Position of `id` in a raw snapshot frame, in wire units, without a full decode. */
function findInSnapshot(data: Buffer, id: number): { xw: number; yw: number } | null {
  const count = data.readUInt16LE(1);
  for (let i = 0, o = 3; i < count; i++, o += SNAPSHOT_ENTRY) {
    if (data.readUInt16LE(o) === id) return { xw: data.readUInt16LE(o + 2), yw: data.readUInt16LE(o + 4) };
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
  const map = CollisionMap.parse(readFileSync(resolve(ROOT, "client/public/assets/collision.txt"), "utf8"));
  const bots: Bot[] = [];
  let url = "";
  let chatEveryMs = 30_000;
  let movingRatio = 1;
  let gaps = new Histogram();
  let chat = new Histogram();
  let move = new Histogram();
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
      walking: true,
      phaseUntil: 0,
      pending: [],
    };
    // Start at a random point of the walk/idle cycle so the room mixes both.
    if (movingRatio <= 0 || movingRatio >= 1) {
      bot.walking = movingRatio > 0;
      bot.phaseUntil = Infinity;
    } else {
      bot.walking = Math.random() < movingRatio;
      bot.phaseUntil = Date.now() + Math.random() * (bot.walking ? walkMs() : idleMs(movingRatio));
    }
    ws.on("open", () => ws.send(encodeClientMessage({ t: "join", name: `bot${bots.length}`, character })));
    ws.on("message", (data: Buffer) => {
      counters.bytesIn += data.length;
      const now = performance.now();
      // Snapshots are only scanned for our own entry, not decoded, to keep bots cheap.
      if (data[0] === SNAPSHOT_OPCODE) {
        counters.snapshots++;
        if (bot.lastSnapshot) gaps.add(now - bot.lastSnapshot);
        bot.lastSnapshot = now;
        const own = bot.pending.length ? findInSnapshot(data, bot.id) : null;
        if (own) {
          const i = bot.pending.findLastIndex((p) => p.xw === own.xw && p.yw === own.yw);
          if (i >= 0) {
            move.add(now - bot.pending[i].t);
            bot.pending.splice(0, i + 1);
          }
        }
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
      const offset = collisionOffsetY(bot.character);
      let next = map.moveWithCollision(bot.x, bot.y, d.dx * stepPx, d.dy * stepPx, offset);
      const snapped = { x: quantize(next.x), y: quantize(next.y) };
      next = map.canStandAt(snapped.x, snapped.y, offset) ? snapped : bot;
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
    };
    process.send!(report);
    gaps = new Histogram();
    chat = new Histogram();
    move = new Histogram();
    counters = { snapshots: 0, bytesIn: 0, bytesOut: 0, corrections: 0, closes: 0, errors: 0 };
  }, 1000);

  type Command = { cmd: "config"; url: string; chatEveryMs: number; movingRatio: number } | { cmd: "add"; room: string };
  process.on("message", (msg: Command) => {
    if (msg.cmd === "config") {
      url = msg.url;
      chatEveryMs = msg.chatEveryMs;
      movingRatio = msg.movingRatio;
    } else {
      addBot(msg.room);
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
  /** null on runtimes that do not report it (Bun, Deno). */
  elu: number | null;
  loopP99Ms: number;
  rssMb: number;
}

interface HealthReport {
  runtime?: string;
  now: number;
  latest: StatsSample | null;
  samples: StatsSample[];
}

const USAGE = `Usage: npm run loadtest -- [options]

  --steps <n,n,...>    total bot counts to ramp through         (default 50,100,200)
  --room-size <n>      bots per room; 0 = everyone in one room   (default 0)
  --hold <s>           seconds at each step; 2nd half measured   (default 20)
  --ramp <n>           new connections per second                (default 100)
  --workers <n>        bot processes                             (default 6)
  --chat-every <s>     seconds between chat messages per bot     (default 30)
  --moving <0..1>      share of time each bot spends walking; the rest it stands
                       still and sends nothing (default 1 = everyone always walking)
  --target <url>       test a running server instead of spawning one,
                       e.g. https://meet.example.com
  --health-token <s>   token for the server's /api/health, if it sets HEALTH_TOKEN
  --runtime <name>     runtime for the spawned server: node, bun or deno (default node)
  --port <n>           port for the spawned server               (default 3300)
  --room-prefix <s>    rooms are <prefix>-all or <prefix>-0, -1, ... (default load)
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
  port: number;
  runtime: "node" | "bun" | "deno";
  roomPrefix: string;
  keepGoing: boolean;
  healthToken: string;
  /** Remote server, or null to spawn a local one. */
  target: { ws: string; http: string } | null;
}

const OPTION_NAMES = [
  "steps",
  "room-size",
  "hold",
  "ramp",
  "workers",
  "chat-every",
  "moving",
  "target",
  "health-token",
  "runtime",
  "port",
  "room-prefix",
  "keep-going",
  "last",
];

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

  let argv = process.argv.slice(2);
  if (argv.includes("--last")) {
    let saved: string[];
    try {
      saved = JSON.parse(readFileSync(LAST_FILE, "utf8")).argv;
    } catch {
      fail(`--last: no previous run saved (${LAST_FILE})`);
    }
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
        moving: { type: "string", default: "1" },
        target: { type: "string" },
        "health-token": { type: "string", default: "" },
        port: { type: "string", default: "3300" },
        runtime: { type: "string", default: "node" },
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
  // Canonical form: each given option once, with its final value.
  const given = new Map<string, string | undefined>();
  for (const t of tokens) if (t.kind === "option") given.set(t.name, t.value);
  const reusedLast = process.argv.includes("--last");
  argv = [...given].flatMap(([name, value]) => (value === undefined ? [`--${name}`] : [`--${name}`, value]));
  if (reusedLast) console.log(`Re-running: npm run loadtest -- ${describe(argv)}`);

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
  const runtime = values.runtime;
  if (runtime !== "node" && runtime !== "bun" && runtime !== "deno") fail(`--runtime must be node, bun or deno, got "${runtime}"`);
  if (values.target !== undefined && given.has("runtime")) fail("--runtime only applies to the spawned server, not --target");

  const options: Options = {
    steps,
    roomSize: int("room-size", values["room-size"], 0),
    hold: int("hold", values.hold, 2),
    ramp: int("ramp", values.ramp, 1),
    workers: int("workers", values.workers, 1),
    chatEveryMs: int("chat-every", values["chat-every"], 1) * 1000,
    movingRatio: ratio("moving", values.moving),
    port: int("port", values.port, 1),
    runtime,
    roomPrefix: values["room-prefix"],
    keepGoing: values["keep-going"],
    healthToken: values["health-token"],
    target: values.target === undefined ? null : parseTarget(values.target),
  };
  // The server keeps 5 minutes of samples; a longer window would be cut short.
  if (options.hold / 2 > 290) fail("--hold must be at most 580 seconds");

  writeFileSync(LAST_FILE, JSON.stringify({ argv, savedAt: new Date().toISOString() }, null, 2) + "\n");
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

/**
 * How to start the local server per runtime. Bun and Deno are fetched by npx on
 * first use (pinned, same versions as Dockerfile.bun / Dockerfile.deno); they are
 * not devDependencies because Deno's npm installer fails on Alpine (musl) builds.
 */
const SERVER_COMMANDS: Record<Options["runtime"], string[]> = {
  node: [process.execPath, "server/src/index.ts"],
  bun: ["npx", "-y", "bun@1.4.2", "run", "server/src/bun.ts"],
  deno: [
    "npx",
    "-y",
    "deno@2.9.6",
    "run",
    "--allow-net",
    "--allow-read",
    "--allow-env",
    "--allow-write",
    "--allow-sys",
    "server/src/deno.ts",
  ],
};

async function runOrchestrator(): Promise<void> {
  const opts = parseOptions();
  const { steps, roomSize, hold, ramp, chatEveryMs, roomPrefix } = opts;
  const workerCount = opts.workers;

  // Either spawn a local server or use the remote one; both report through /api/health.
  let server: ChildProcess | null = null;
  let wsUrl: string;
  let httpUrl: string;
  if (opts.target) {
    ({ ws: wsUrl, http: httpUrl } = opts.target);
  } else {
    wsUrl = `ws://127.0.0.1:${opts.port}${WS_PATH}`;
    httpUrl = `http://127.0.0.1:${opts.port}`;
    server = spawn(SERVER_COMMANDS[opts.runtime][0], SERVER_COMMANDS[opts.runtime].slice(1), {
      cwd: ROOT,
      env: { ...process.env, PORT: String(opts.port), HOST: "0.0.0.0", HEALTH_TOKEN: opts.healthToken, NODE_ENV: "production" },
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  const health = new HealthClient(httpUrl, opts.healthToken);
  let runtimeLabel = "unknown runtime";
  try {
    await health.waitReady(opts.target ? 0 : 60_000);
    runtimeLabel = (await health.fetch(Date.now())).runtime ?? runtimeLabel;
  } catch (err) {
    server?.kill();
    fail((err as Error).message);
  }
  console.log(opts.target ? `Target ${wsUrl} (${runtimeLabel})` : `Spawned ${runtimeLabel} server on port ${opts.port}`);
  console.log(`Bots walk ${Math.round(opts.movingRatio * 100)}% of the time`);
  console.log(`Rooms: /r/${roomSize > 0 ? `${roomPrefix}-0 .. ${roomPrefix}-${Math.ceil(steps.at(-1)! / roomSize) - 1}` : `${roomPrefix}-all`}`);

  const workers: ChildProcess[] = [];
  let window: WorkerReport[] = [];
  const connected = new Map<ChildProcess, number>();
  for (let i = 0; i < workerCount; i++) {
    const w = fork(import.meta.filename, ["--worker"], { stdio: "inherit" });
    w.send({ cmd: "config", url: wsUrl, chatEveryMs, movingRatio: opts.movingRatio });
    w.on("message", (r: WorkerReport) => {
      window.push(r);
      connected.set(w, r.connected);
    });
    workers.push(w);
  }

  const roomFor = (i: number) => (roomSize > 0 ? `${roomPrefix}-${Math.floor(i / roomSize)}` : `${roomPrefix}-all`);
  let total = 0;
  console.log(
    "bots | rooms | srv players | srv CPU | ELU  | loop p99 | RSS MB | move p50/p99 ms | snap gap p50/p99/max ms | chat p50/p99 ms | in MB/s | corr | drops | verdict",
  );

  for (const target of steps) {
    // Ramp up at a fixed connection rate.
    while (total < target) {
      const batch = Math.min(target - total, Math.max(1, Math.round(ramp / 10)));
      for (let i = 0; i < batch; i++, total++) workers[total % workerCount].send({ cmd: "add", room: roomFor(total) });
      await sleep(100);
    }
    await sleep((hold / 2) * 1000);

    // Measure the second half of the hold: bot reports plus the server's own samples.
    window = [];
    let serverFrom: number | null = null;
    let healthProblem = "";
    try {
      serverFrom = (await health.fetch(Date.now())).now;
    } catch (err) {
      healthProblem = (err as Error).message;
    }
    const t0 = Date.now();
    await sleep((hold / 2) * 1000);
    const elapsed = (Date.now() - t0) / 1000;
    let samples: StatsSample[] = [];
    let latest: StatsSample | null = null;
    if (serverFrom !== null) {
      try {
        const report = await health.fetch(serverFrom);
        samples = report.samples;
        latest = report.latest;
      } catch (err) {
        healthProblem = (err as Error).message;
      }
    }
    if (healthProblem) console.warn(`  (server stats unavailable: ${healthProblem})`);

    const gaps = new Histogram();
    const chat = new Histogram();
    const move = new Histogram();
    let bytesIn = 0;
    let corrections = 0;
    let drops = 0;
    let socketErrors = 0;
    for (const r of window) {
      gaps.merge(r.gaps);
      chat.merge(r.chat);
      move.merge(r.move);
      bytesIn += r.bytesIn;
      corrections += r.corrections;
      drops += r.closes;
      socketErrors += r.errors;
    }
    const joined = [...connected.values()].reduce((a, b) => a + b, 0);
    const mean = (key: keyof StatsSample) => samples.reduce((a, s) => a + (s[key] ?? 0), 0) / samples.length;
    const have = samples.length > 0;
    const cpu = have ? mean("cpu") : NaN;
    const elu = have && samples.every((s) => s.elu !== null) ? mean("elu") : NaN;
    const loopP99 = have ? Math.max(...samples.map((s) => s.loopP99Ms)) : NaN;
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
    if (drops > 0) problems.push("disconnects");
    if (socketErrors > 0) problems.push(`${socketErrors} socket errors`);
    if (loopP99 > 50) problems.push("event loop lag");
    const verdict = problems.length ? `FAIL (${problems.join(", ")})` : "ok";

    const row = [
      String(target).padStart(4),
      String(roomSize > 0 ? Math.ceil(target / roomSize) : 1).padStart(5),
      String(latest?.players ?? "-").padStart(11),
      show(cpu, () => `${(cpu * 100).toFixed(0)}%`).padStart(7),
      show(elu, () => elu.toFixed(2)).padStart(4),
      show(loopP99, () => loopP99.toFixed(1)).padStart(8),
      String(latest?.rssMb ?? "-").padStart(6),
      (move.total ? `${move.percentile(0.5)}/${moveP99}` : "-").padStart(15),
      `${gaps.percentile(0.5)}/${gapP99}/${gaps.percentile(1)}`.padStart(23),
      (chat.total ? `${chat.percentile(0.5)}/${chatP99}` : "-").padStart(15),
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
