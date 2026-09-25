import { monitorEventLoopDelay, performance } from "node:perf_hooks";

/** One second of server load, as served by GET /api/health. */
export interface StatsSample {
  /** Server clock, Unix epoch milliseconds, at the end of the sample. */
  t: number;
  rooms: number;
  players: number;
  sockets: number;
  /** Process CPU time over wall time; 1 = one full core. */
  cpu: number;
  /** Event loop utilization, 0..1. */
  elu: number;
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

/** Samples process load once per second and keeps a rolling history. */
export class StatsSampler {
  private readonly samples: StatsSample[] = [];
  private readonly startedAt = Date.now();

  constructor(counts: () => Counts, onSample?: (s: StatsSample) => void) {
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    let lastElu = performance.eventLoopUtilization();
    let lastCpu = process.cpuUsage();
    let lastAt = performance.now();

    setInterval(() => {
      const now = performance.now();
      const elu = performance.eventLoopUtilization(lastElu);
      const cpu = process.cpuUsage(lastCpu);
      const mem = process.memoryUsage();
      const sample: StatsSample = {
        t: Date.now(),
        ...counts(),
        cpu: round((cpu.user + cpu.system) / 1000 / (now - lastAt), 3),
        elu: round(elu.utilization, 3),
        loopP99Ms: round(loopDelay.percentile(99) / 1e6, 1),
        loopMaxMs: round(loopDelay.max / 1e6, 1),
        rssMb: Math.round(mem.rss / 1e6),
        heapMb: Math.round(mem.heapUsed / 1e6),
      };
      lastElu = performance.eventLoopUtilization();
      lastCpu = process.cpuUsage();
      lastAt = now;
      loopDelay.reset();

      this.samples.push(sample);
      if (this.samples.length > HISTORY) this.samples.shift();
      onSample?.(sample);
    }, SAMPLE_MS).unref();
  }

  /** Body of GET /api/health; `since` (server epoch ms) limits the history returned. */
  report(since = 0) {
    return {
      status: "ok",
      now: Date.now(),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      latest: this.samples.at(-1) ?? null,
      samples: this.samples.filter((s) => s.t > since),
    };
  }
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
