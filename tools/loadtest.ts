/**
 * Load test: spawns the server, then ramps up bot players in steps and reports
 * whether each step stays healthy.
 *
 *   node tools/loadtest.ts --steps 100,200,400 --room-size 20
 *
 * Bots join, walk non-stop (worst case: everyone moving) using the real
 * collision map, send positions at the client rate and chat now and then.
 * Options:
 *   --steps       comma-separated total bot counts to ramp through
 *   --room-size   bots per room; 0 puts everyone in one room (default 0)
 *   --hold        seconds to stay at each step (default 20; last half is measured)
 *   --ramp        new connections per second (default 100)
 *   --workers     bot processes (default 6)
 *   --chat-every  seconds between chat messages per bot (default 30)
 *   --port        server port (default 3300)
 */
import { fork, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import { CHARACTER_IDS, collisionOffsetY, type CharacterId, type Direction } from "../shared/src/characters.ts";
import { CollisionMap } from "../shared/src/collision.ts";
import { MOVE_SPEED, TICK_RATE } from "../shared/src/constants.ts";
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

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** CPU seconds (user + system) consumed so far by a process. */
function cpuSeconds(pid: number): number {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  return (Number(fields[11]) + Number(fields[12])) / 100;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOrchestrator(): Promise<void> {
  const steps = arg("steps", "50,100,200").split(",").map(Number);
  const roomSize = Number(arg("room-size", "0"));
  const hold = Number(arg("hold", "20"));
  const ramp = Number(arg("ramp", "100"));
  const workerCount = Number(arg("workers", "6"));
  const chatEveryMs = Number(arg("chat-every", "30")) * 1000;
  const port = Number(arg("port", "3300"));

  const server = spawn(process.execPath, ["server/src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), LOG_STATS: "1", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let serverStats: ServerStats[] = [];
  server.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.startsWith('{"stats"')) serverStats.push(JSON.parse(line));
    }
  });
  await sleep(1000);

  const workers: ChildProcess[] = [];
  let window: WorkerReport[] = [];
  let connected = new Map<ChildProcess, number>();
  for (let i = 0; i < workerCount; i++) {
    const w = fork(import.meta.filename, ["--worker"], { stdio: "inherit" });
    w.send({ cmd: "config", url: `ws://127.0.0.1:${port}/ws`, chatEveryMs });
    w.on("message", (r: WorkerReport) => {
      window.push(r);
      connected.set(w, r.connected);
    });
    workers.push(w);
  }

  const roomFor = (i: number) => (roomSize > 0 ? `load-${Math.floor(i / roomSize)}` : "load-all");
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
    const cpuStart = cpuSeconds(server.pid!);
    const t0 = Date.now();
    await sleep((hold / 2) * 1000);
    const elapsed = (Date.now() - t0) / 1000;
    const cpu = (cpuSeconds(server.pid!) - cpuStart) / elapsed;

    const gaps = new Histogram();
    const chat = new Histogram();
    let bytesIn = 0;
    let corrections = 0;
    let drops = 0;
    for (const r of window) {
      gaps.merge(r.gaps);
      chat.merge(r.chat);
      bytesIn += r.bytesIn;
      corrections += r.corrections;
      drops += r.closes;
    }
    const joined = [...connected.values()].reduce((a, b) => a + b, 0);
    const avg = (key: keyof ServerStats) => serverStats.reduce((a, s) => a + s[key], 0) / (serverStats.length || 1);
    const loopP99 = Math.max(...serverStats.map((s) => s.loopP99Ms), 0);
    const last = serverStats.at(-1);

    const gapP99 = gaps.percentile(0.99);
    const chatP99 = chat.percentile(0.99);
    const problems = [];
    if (joined < target) problems.push(`only ${joined} joined`);
    if (!(gapP99 <= 100)) problems.push("snapshots late");
    if (chat.total > 0 && chatP99 > 250) problems.push("chat slow");
    if (drops > 0) problems.push("disconnects");
    if (loopP99 > 50) problems.push("event loop lag");
    const verdict = problems.length ? `FAIL (${problems.join(", ")})` : "ok";

    const row = [
      String(target).padStart(4),
      String(last?.rooms ?? "?").padStart(5),
      `${(cpu * 100).toFixed(0)}%`.padStart(7),
      avg("elu").toFixed(2).padStart(4),
      `${loopP99.toFixed(1)}`.padStart(8),
      String(last?.rssMb ?? "?").padStart(6),
      `${gaps.percentile(0.5)}/${gapP99}/${gaps.percentile(1)}`.padStart(23),
      `${chat.percentile(0.5)}/${chatP99}`.padStart(15),
      (bytesIn / elapsed / 1e6).toFixed(1).padStart(7),
      String(corrections).padStart(4),
      String(drops).padStart(5),
      verdict,
    ].join(" | ");
    console.log(row);
    if (problems.length && !process.argv.includes("--keep-going")) break;
  }

  for (const w of workers) w.kill();
  server.kill();
  process.exit(0);
}

if (process.argv.includes("--worker")) runWorker();
else runOrchestrator();
