/**
 * Schema migrations: numbered SQL files in ./migrations, applied in name order,
 * each in its own transaction and recorded in schema_migrations. An advisory lock
 * makes it safe for several servers of a cluster to start at once: one applies,
 * the others wait and then find nothing left to do.
 *
 *   bun run db:migrate
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SQL } from "bun";
import { openDb } from "./db.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;
/** Any constant; identifies Daystar's migration lock among other advisory locks. */
const LOCK_KEY = 0x44_59_53_54; // "DYST"

/** Migration files in the order they apply. */
export async function migrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql"));
  const bad = names.filter((n) => !FILE_PATTERN.test(n));
  if (bad.length) throw new Error(`migration files must be named 001_name.sql: ${bad.join(", ")}`);
  return names.sort();
}

/** Applies the migrations not applied yet; returns their names. */
export async function migrate(sql: SQL, dir = MIGRATIONS_DIR): Promise<string[]> {
  // Under the lock too: two servers running CREATE TABLE IF NOT EXISTS at the same
  // moment can still collide.
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
  });
  const applied: string[] = [];
  for (const name of await migrationFiles(dir)) {
    const body = await Bun.file(join(dir, name)).text();
    const ran = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
      const [done] = await tx`SELECT 1 FROM schema_migrations WHERE version = ${name}`;
      if (done) return false;
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (version) VALUES (${name})`;
      return true;
    });
    if (ran) applied.push(name);
  }
  return applied;
}

if (import.meta.main) {
  const sql = openDb({ max: 1 });
  if (!sql) {
    console.error("PGHOST is not set; nothing to migrate (see example.env)");
    process.exit(1);
  }
  try {
    const applied = await migrate(sql);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
  } finally {
    await sql.close();
  }
}
