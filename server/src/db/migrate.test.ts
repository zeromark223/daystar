/** Runs against the database in .env (see test-db.ts); skipped without one. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { SQL } from "bun";
import { dbConfigured } from "./db.ts";
import { migrate, migrationFiles } from "./migrate.ts";
import { createTestDb, type TestDb } from "./test-db.ts";

describe("migrations", { skip: !dbConfigured() && "PGHOST is not set" }, () => {
  let db: TestDb;
  let sql: SQL;

  before(async () => {
    db = await createTestDb();
    sql = db.sql;
  });

  after(() => db?.drop());

  test("apply once, even when two servers start together", async () => {
    const [a, b] = await Promise.all([migrate(sql), migrate(db.pool())]);
    assert.deepEqual([...a, ...b].sort(), await migrationFiles());
    assert.deepEqual(await migrate(sql), []);
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${db.schema}`;
    assert.deepEqual(
      tables.map((t: { table_name: string }) => t.table_name).sort(),
      ["loadtest_rows", "loadtest_runs", "refresh_tokens", "room_members", "rooms", "schema_migrations", "users"],
    );
  });

  test("a domain-only room needs its domain", async () => {
    const [user] = await sql`INSERT INTO users (authentik_sub) VALUES ('sub-domain') RETURNING id`;
    await assert.rejects(sql`INSERT INTO rooms (id, owner_id, access) VALUES ('calm-orbit-aaaaaa', ${user.id}, 'domain')`);
    await sql`INSERT INTO rooms (id, owner_id, access, allowed_domain) VALUES ('calm-orbit-aaaaaa', ${user.id}, 'domain', 'example.com')`;
    await assert.rejects(sql`INSERT INTO rooms (id, owner_id, access) VALUES ('calm-orbit-bbbbbb', ${user.id}, 'everyone')`);
  });

  test("deleting an account deletes its tokens, rooms and memberships", async () => {
    const [owner] = await sql`INSERT INTO users (authentik_sub) VALUES ('sub-owner') RETURNING id`;
    const [guest] = await sql`INSERT INTO users (authentik_sub) VALUES ('sub-guest') RETURNING id`;
    await sql`INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
      VALUES (${owner.id}, gen_random_uuid(), ${randomBytes(32)}, now() + interval '1 day')`;
    await sql`INSERT INTO rooms (id, owner_id) VALUES ('quiet-halo-cccccc', ${owner.id})`;
    await sql`INSERT INTO room_members (room_id, user_id, role) VALUES ('quiet-halo-cccccc', ${guest.id}, 'speaker')`;
    await sql`DELETE FROM users WHERE id = ${owner.id}`;
    const [left] = await sql`SELECT
      (SELECT count(*) FROM refresh_tokens WHERE user_id = ${owner.id})::int AS tokens,
      (SELECT count(*) FROM rooms WHERE owner_id = ${owner.id})::int AS rooms,
      (SELECT count(*) FROM room_members WHERE room_id = 'quiet-halo-cccccc')::int AS members`;
    assert.deepEqual({ ...left }, { tokens: 0, rooms: 0, members: 0 });
  });
});

test("migration files must be numbered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daystar-migrations-"));
  try {
    await writeFile(join(dir, "002_second.sql"), "");
    await writeFile(join(dir, "001_first.sql"), "");
    assert.deepEqual(await migrationFiles(dir), ["001_first.sql", "002_second.sql"]);
    await writeFile(join(dir, "add-users.sql"), "");
    await assert.rejects(migrationFiles(dir), /001_name\.sql/);
  } finally {
    await rm(dir, { recursive: true });
  }
});
