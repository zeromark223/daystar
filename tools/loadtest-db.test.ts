/** The load test's database log, in a throwaway schema; skipped without PGHOST. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dbConfigured } from "../server/src/db/db.ts";
import { createTestDb, type TestDb } from "../server/src/db/test-db.ts";
import { RunLog } from "./loadtest-db.ts";

describe("load test runs in the database", { skip: !dbConfigured() && "PGHOST is not set" }, () => {
  let db: TestDb;
  before(async () => {
    db = await createTestDb({ migrate: true });
  });
  after(() => db?.drop());

  const meta = { name: "smoke", command: "bun tools/loadtest.ts --steps 50", target: "ws://x/ws", runtime: "bun 1.4.2" };

  test("a run, its rows and its outcome", async () => {
    const warnings: string[] = [];
    const log = (await RunLog.open(meta, (t) => warnings.push(t), db.pool(2)))!;
    log.row({ time_s: 7, bots: 50, loop_p99_ms: 2.4, voice_p99_ms: NaN, verdict: "ok" });
    log.row({ time_s: 13, bots: 100, loop_p99_ms: 61, voice_p99_ms: 140, verdict: "FAIL (loop p99)" });
    await log.end("done", "Summary: last row meeting every target at 50 bots", { maxOk: 50, firstFail: 100 });
    await log.end("failed", "ignored: the first end wins");

    const [run] = await db.sql`SELECT * FROM loadtest_runs WHERE id = ${log.id}`;
    assert.equal(run.status, "done");
    assert.equal(run.name, "smoke");
    assert.equal(run.max_ok_bots, 50);
    assert.equal(run.first_fail_bots, 100);
    assert.ok(run.ended_at);
    const rows = await db.sql`SELECT seq, bots, ok, verdict, metrics FROM loadtest_rows WHERE run_id = ${log.id} ORDER BY seq`;
    assert.deepEqual(
      rows.map((r: { seq: number; bots: number; ok: boolean }) => [r.seq, r.bots, r.ok]),
      [[1, 50, true], [2, 100, false]],
    );
    // Not measured (NaN) is stored as null.
    assert.equal(rows[0].metrics.voice_p99_ms, null);
    assert.equal(rows[1].metrics.loop_p99_ms, 61);
    assert.deepEqual(warnings, []);
  });

  test("no database, or an unreachable one, never stops the run", async () => {
    assert.equal(await RunLog.open(meta, () => {}, null), null);
    const warnings: string[] = [];
    const { SQL } = await import("bun");
    const unreachable = new SQL({ hostname: "127.0.0.1", port: 1, connectionTimeout: 2 });
    assert.equal(await RunLog.open(meta, (t) => warnings.push(t), unreachable), null);
    assert.match(warnings[0], /Database log off/);
  });
});
