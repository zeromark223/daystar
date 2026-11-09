/**
 * Tests against the database in .env, each in a throwaway schema dropped at the
 * end, so they never touch the tables you use by hand.
 */
import { randomBytes } from "node:crypto";
import type { SQL } from "bun";
import { openDb } from "./db.ts";
import { migrate } from "./migrate.ts";

export interface TestDb {
  schema: string;
  /** A pool whose search_path is the test schema. */
  pool(max?: number): SQL;
  sql: SQL;
  drop(): Promise<void>;
}

export async function createTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const admin = openDb({ max: 1 })!;
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const pools: SQL[] = [];
  const pool = (max = 4) => {
    const p = openDb({ max, connection: { search_path: schema } })!;
    pools.push(p);
    return p;
  };
  const sql = pool();
  if (opts.migrate) await migrate(sql);
  return {
    schema,
    pool,
    sql,
    async drop() {
      await Promise.all(pools.map((p) => p.close()));
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.close();
    },
  };
}
