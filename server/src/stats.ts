import { performance } from "node:perf_hooks";

/** One second of server load, as served by GET /api/health. */
export interface StatsSample {
  /** Server clock, Unix epoch milliseconds, at the end of the sample. */
  t: number;
  rooms: number;
  players: number;
  sockets: number;
  /** Process CPU time over wall time; 1 = one full core. */
  cpu: number;
  /** Event loop utilization, 0..1; null where the runtime does not report it (Bun, Deno). */
  elu: number | null;
  /** How late a 20 ms timer fired: p99 and max over the sample. */
  loopP99Ms: number;
  loopMaxMs: number;
  rssMb: number;
  heapMb: number;
}

export interface Counts {
  rooms: number;
  players: number;
  sockets: number;
}

const SAMPLE_MS = 1000;
/** Five minutes of history, enough for a load test step to read back its window. */
const HISTORY = 300;
const PROBE_MS = 20;

/**
 * Samples process load once per second and keeps a rolling history.
 * Everything here works the same on Node, Bun and Deno so runtimes can be compared;
 * loop delay in particular is measured with a timer probe rather than
 * monitorEventLoopDelay, which only Node implements.
 */
export class StatsSampler {
  private readonly samples: StatsSample[] = [];
  private readonly startedAt = Date.now();
  private readonly runtime: string;
  private lateness: number[] = [];

  constructor(counts: () => Counts, onSample?: (s: StatsSample) => void) {
    this.runtime = runtimeName();
    this.probe(performance.now() + PROBE_MS);

    const elu = performance.eventLoopUtilization as typeof performance.eventLoopUtilization | undefined;
    let lastElu = elu?.();
    let eluSeen = false;
    let lastCpu = process.cpuUsage();
    let lastAt = performance.now();

    setInterval(() => {
      const now = performance.now();
      const cpu = process.cpuUsage(lastCpu);
      const mem = process.memoryUsage();
      // Bun and Deno expose the function but always report zero.
      const eluNow = lastElu && elu ? elu(lastElu) : null;
      if (eluNow && eluNow.active > 0) eluSeen = true;

      const late = this.lateness.sort((a, b) => a - b);
      this.lateness = [];
      const sample: StatsSample = {
        t: Date.now(),
        ...counts(),
        cpu: round((cpu.user + cpu.system) / 1000 / (now - lastAt), 3),
        elu: eluSeen && eluNow ? round(eluNow.utilization, 3) : null,
        loopP99Ms: round(late[Math.min(late.length - 1, Math.floor(late.length * 0.99))] ?? 0, 1),
        loopMaxMs: round(late.at(-1) ?? 0, 1),
        rssMb: Math.round(mem.rss / 1e6),
        heapMb: Math.round(mem.heapUsed / 1e6),
      };
      lastElu = elu?.();
      lastCpu = process.cpuUsage();
      lastAt = now;

      this.samples.push(sample);
      if (this.samples.length > HISTORY) this.samples.shift();
      onSample?.(sample);
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

function runtimeName(): string {
  const g = globalThis as { Bun?: { version: string }; Deno?: { version: { deno: string } } };
  if (g.Bun) return `bun ${g.Bun.version}`;
  if (g.Deno) return `deno ${g.Deno.version.deno}`;
  return `node ${process.versions.node}`;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
