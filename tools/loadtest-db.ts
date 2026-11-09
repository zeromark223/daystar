/**
 * Load test runs in Postgres (tables loadtest_runs and loadtest_rows, migration
 * 002_loadtest.sql), alongside the CSV. On when PGHOST is set (Bun loads .env),
 * off with --no-db. The database never gets in the way of a run: if it cannot be
 * reached the run goes on with a warning, and row writes do not hold up the bots.
 *
 *   bun run loadtest:runs        # recent runs
 *   bun run loadtest:runs 12     # the rows of run 12
 */
import { hostname } from "node:os";
import type { SQL } from "bun";
import { dbConfigured, openDb } from "../server/src/db/db.ts";
import { migrate } from "../server/src/db/migrate.ts";

export interface RunMeta {
  name: string | null;
  command: string;
  target: string;
  runtime: string;
}

export type RunStatus = "done" | "stopped" | "failed";

export class RunLog {
  private seq = 0;
  /** Row writes in flight, awaited before the run is closed. */
  private pending: Promise<unknown>[] = [];
  private warned = false;
  private ended = false;

  readonly id: number;
  private readonly sql: SQL;
  private readonly warn: (text: string) => void;

  private constructor(id: number, sql: SQL, warn: (text: string) => void) {
    this.id = id;
    this.sql = sql;
    this.warn = warn;
  }

  /** A new run in the database, or null when there is none (or it is unreachable). */
  static async open(meta: RunMeta, warn: (text: string) => void, sql: SQL | null = openDb({ max: 2 })): Promise<RunLog | null> {
    if (!sql) return null;
    try {
      await migrate(sql);
      const [row] = await sql`
        INSERT INTO loadtest_runs (name, command, target, runtime, host)
        VALUES (${meta.name}, ${meta.command}, ${meta.target}, ${meta.runtime}, ${hostname()})
        RETURNING id`;
      return new RunLog(Number(row.id), sql, warn);
    } catch (err) {
      warn(`Database log off: ${(err as Error).message}`);
      await sql.close().catch(() => {});
      return null;
    }
  }

  /** One measured row (the CSV's columns by name); written in the background. */
  row(values: Record<string, string | number>): void {
    const seq = ++this.seq;
    const verdict = String(values.verdict ?? "");
    // NaN (not measured) becomes null in JSON.
    const metrics = JSON.parse(JSON.stringify(values));
    const write = this.sql`
      INSERT INTO loadtest_rows (run_id, seq, time_s, bots, ok, verdict, metrics)
      VALUES (${this.id}, ${seq}, ${Number(values.time_s) || 0}, ${Number(values.bots) || 0}, ${verdict === "ok"}, ${verdict}, ${metrics})`.catch(
      (err: Error) => {
        if (!this.warned) this.warn(`Database log: a row was not saved (${err.message})`);
        this.warned = true;
      },
    );
    this.pending.push(write);
  }

  /** Closes the run with its outcome; safe to call twice (the first call wins). */
  async end(status: RunStatus, summary: string, bests: { maxOk: number | null; firstFail: number | null } = { maxOk: null, firstFail: null }): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await Promise.all(this.pending);
    try {
      await this.sql`
        UPDATE loadtest_runs
        SET ended_at = now(), status = ${status}, summary = ${summary},
            max_ok_bots = ${bests.maxOk}, first_fail_bots = ${bests.firstFail}
        WHERE id = ${this.id}`;
    } catch (err) {
      this.warn(`Database log: the run's end was not saved (${(err as Error).message})`);
    } finally {
      await this.sql.close().catch(() => {});
    }
  }
}

// ------------------------------------------------------------ viewer

async function listRuns(sql: SQL): Promise<void> {
  const runs = await sql`
    SELECT id, name, started_at, ended_at, status, target, runtime, host, max_ok_bots, first_fail_bots, summary,
           (SELECT count(*)::int FROM loadtest_rows r WHERE r.run_id = runs.id) AS rows
    FROM loadtest_runs runs ORDER BY started_at DESC LIMIT 25`;
  if (!runs.length) return console.log("No load test runs in the database yet.");
  console.table(
    runs.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      started: (r.started_at as Date).toISOString().slice(0, 16).replace("T", " "),
      min: r.ended_at ? Math.round(((r.ended_at as Date).getTime() - (r.started_at as Date).getTime()) / 60_000) : "-",
      status: r.status,
      name: r.name ?? "",
      target: r.target,
      runtime: r.runtime ?? "",
      rows: r.rows,
      "ok up to": r.max_ok_bots ?? "-",
      "fails at": r.first_fail_bots ?? "-",
    })),
  );
}

async function showRun(sql: SQL, id: number): Promise<void> {
  const [run] = await sql`SELECT * FROM loadtest_runs WHERE id = ${id}`;
  if (!run) return console.log(`No run ${id}.`);
  console.log(`Run ${id}: ${run.command}\n  ${run.target} (${run.runtime ?? "?"}) from ${run.host ?? "?"}, ${run.status}`);
  if (run.summary) console.log(`  ${run.summary}`);
  const rows = await sql`SELECT time_s, bots, ok, verdict, metrics FROM loadtest_rows WHERE run_id = ${id} ORDER BY seq`;
  console.table(
    rows.map((r: { time_s: number; bots: number; verdict: string; metrics: Record<string, number | null> }) => ({
      "t s": r.time_s,
      bots: r.bots,
      "srv CPU": r.metrics.srv_cpu == null ? "-" : `${Math.round(r.metrics.srv_cpu * 100)}%`,
      "out Mbps": r.metrics.out_mbps ?? "-",
      "loop p99": r.metrics.loop_p99_ms ?? "-",
      "move p99": r.metrics.move_p99_ms ?? "-",
      "voice p99": r.metrics.voice_p99_ms ?? "-",
      "RSS MB": r.metrics.rss_mb ?? "-",
      verdict: r.verdict,
    })),
  );
}

if (import.meta.main) {
  if (!dbConfigured()) {
    console.error("PGHOST is not set (see example.env)");
    process.exit(1);
  }
  const sql = openDb({ max: 1 })!;
  try {
    await migrate(sql);
    const id = Number(process.argv[2]);
    if (process.argv[2] && Number.isInteger(id)) await showRun(sql, id);
    else await listRuns(sql);
  } finally {
    await sql.close();
  }
}
