/** One second of server load, as served by GET /api/health. */
export interface StatsSample {
  /** Server clock, Unix epoch milliseconds, at the end of the sample. */
  t: number;
  rooms: number;
  players: number;
  sockets: number;
  /** Process CPU time over wall time; 1 = one full core. */
  cpu: number;
  /** How late a 20 ms timer fired: p99 and max over the sample. */
  loopP99Ms: number;
  loopMaxMs: number;
  /** Room ticks run and their processing time (encode + send/publish). */
  ticks: number;
  tickP99Ms: number;
  tickMaxMs: number;
  rssMb: number;
  heapMb: number;
  /** Bytes sent to players (snapshots and room events), in Mbit/s. */
  egressMbps: number;
  /** Overcharge: snapshots per second per player, and the load score behind it. */
  snapshotHz?: number;
  load?: number;
}

export interface Counts {
  rooms: number;
  players: number;
  sockets: number;
  snapshotHz?: number;
  load?: number;
}

const SAMPLE_MS = 1000;

/** Five minutes of history, enough for a load test step to read back its window. */
const HISTORY = 300;
const PROBE_MS = 20;

let tickDurations: number[] = [];
let egressBytes = 0;
/** Rooms report what they send: frame size times recipients. */
export function recordEgress(bytes: number): void {
  egressBytes += bytes;
}

/** Rooms report how long each tick took (see Room.tick). */
export function recordTick(ms: number): void {
  tickDurations.push(ms);
}

/**
 * Samples process load once per second and keeps a rolling history.
 * Loop delay is measured with a timer probe. Bun reports GC only through
 * BUN_JSC_logGC on stderr, which tools/loadtest.ts parses when it spawns the server.
 */
export class StatsSampler {
  private readonly samples: StatsSample[] = [];
  private readonly startedAt = Date.now();
  private readonly runtime: string;
  private lateness: number[] = [];
  /** Called with every new sample (e.g. to forward it to the cluster agent). */
  readonly listeners = new Set<(s: StatsSample) => void>();

  constructor(counts: () => Counts, onSample?: (s: StatsSample) => void) {
    this.runtime = `bun ${Bun.version}`;
    this.probe(performance.now() + PROBE_MS);

    let lastCpu = process.cpuUsage();
    let lastAt = performance.now();

    setInterval(() => {
      const now = performance.now();
      const cpu = process.cpuUsage(lastCpu);
      const mem = process.memoryUsage();
      const late = this.lateness.sort((a, b) => a - b);
      this.lateness = [];
      const ticks = tickDurations.sort((a, b) => a - b);
      tickDurations = [];
      const egressMbps = round((egressBytes * 8) / 1e6 / ((now - lastAt) / 1000), 1);
      egressBytes = 0;
      const sample: StatsSample = {
        t: Date.now(),
        ...counts(),
        cpu: round((cpu.user + cpu.system) / 1000 / (now - lastAt), 3),
        loopP99Ms: round(percentile(late, 0.99), 1),
        loopMaxMs: round(late.at(-1) ?? 0, 1),
        ticks: ticks.length,
        tickP99Ms: round(percentile(ticks, 0.99), 2),
        tickMaxMs: round(ticks.at(-1) ?? 0, 2),
        rssMb: Math.round(mem.rss / 1e6),
        heapMb: Math.round(mem.heapUsed / 1e6),
        egressMbps,
      };
      lastCpu = process.cpuUsage();
      lastAt = now;

      this.samples.push(sample);
      if (this.samples.length > HISTORY) this.samples.shift();
      onSample?.(sample);
      for (const listener of this.listeners) listener(sample);
    }, SAMPLE_MS);
  }

  /** Re-arms itself every PROBE_MS and records how late each firing was. */
  private probe(expected: number): void {
    setTimeout(() => {
      const now = performance.now();
      this.lateness.push(Math.max(0, now - expected));
      this.probe(now + PROBE_MS);
    }, PROBE_MS);
  }

  /** Body of GET /api/health; `since` (server epoch ms) limits the history returned. */
  report(since = 0) {
    return {
      status: "ok",
      runtime: this.runtime,
      now: Date.now(),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      latest: this.samples.at(-1) ?? null,
      samples: this.samples.filter((s) => s.t > since),
    };
  }
}

/** A report as one line for the chat's System tab (the host's /health). */
export function formatHealth(report: ReturnType<StatsSampler["report"]>, label = "Server"): string {
  const up = formatDuration(report.uptimeSec);
  const s = report.latest;
  if (!s) return `${label}: up ${up}, ${report.runtime}; no load sample yet.`;
  const parts = [
    `${s.rooms} ${s.rooms === 1 ? "room" : "rooms"}, ${s.players} ${s.players === 1 ? "player" : "players"}`,
    `CPU ${Math.round(s.cpu * 100)}%`,
    `loop p99 ${s.loopP99Ms} ms`,
    `tick p99 ${s.tickP99Ms} ms`,
    `memory ${s.rssMb} MB (heap ${s.heapMb} MB)`,
    `egress ${s.egressMbps} Mbit/s`,
  ];
  if (s.snapshotHz !== undefined) parts.push(`${s.snapshotHz} snapshots/s${s.load !== undefined ? `, load ${s.load}` : ""}`);
  return `${label}: up ${up}, ${report.runtime} · ${parts.join(" · ")}`;
}

/** 3725 -> "1h 2m"; under a minute, seconds. */
function formatDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m` : `${sec}s`;
}

/** p-th percentile of an ascending array (0 when empty). */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
