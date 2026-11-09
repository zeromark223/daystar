/**
 * Accounts and refresh tokens in Postgres. A refresh token is 32 random bytes in
 * an HttpOnly cookie; the database keeps only its SHA-256. Every refresh swaps it
 * for a new one in the same family; presenting an already used one (outside a
 * short grace for tabs racing each other) means it leaked, and revokes the family.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SQL } from "bun";
import type { IdClaims } from "./jwt.ts";

export interface User {
  id: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
}

interface UserRow {
  id: bigint | number | string;
  display_name: string | null;
  email: string | null;
  email_verified: boolean;
}

const toUser = (r: UserRow): User => ({
  id: String(r.id),
  name: r.display_name,
  email: r.email,
  emailVerified: r.email_verified,
});

const hash = (token: string) => createHash("sha256").update(token).digest();

/** Creates the account on first login, refreshes its profile on every login. */
export async function upsertUser(sql: SQL, c: IdClaims): Promise<User> {
  const name = c.name || c.preferred_username || null;
  const [row] = await sql`
    INSERT INTO users (authentik_sub, email, email_verified, display_name, last_login_at)
    VALUES (${c.sub}, ${c.email ?? null}, ${c.email_verified === true}, ${name}, now())
    ON CONFLICT (authentik_sub) DO UPDATE SET
      email = EXCLUDED.email,
      email_verified = EXCLUDED.email_verified,
      display_name = EXCLUDED.display_name,
      last_login_at = now()
    RETURNING id, display_name, email, email_verified`;
  return toUser(row);
}

async function insertToken(sql: SQL, userId: string, family: string, ttlDays: number, userAgent: string | null): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`
    INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent)
    VALUES (${userId}, ${family}, ${hash(token)}, now() + make_interval(days => ${ttlDays}), ${userAgent})`;
  return token;
}

/** A new family (one login on one device). */
export function issueRefresh(sql: SQL, userId: string, ttlDays: number, userAgent: string | null): Promise<string> {
  return insertToken(sql, userId, randomUUID(), ttlDays, userAgent?.slice(0, 256) ?? null);
}

export type RotateResult = { ok: true; user: User; token: string } | { ok: false; reason: "unknown" | "expired" | "reused" };

/** Swaps a refresh token for a new one, or says why not. */
export function rotateRefresh(
  sql: SQL,
  token: string,
  opts: { ttlDays: number; graceSec: number; userAgent: string | null },
): Promise<RotateResult> {
  return sql.begin(async (tx): Promise<RotateResult> => {
    const [row] = await tx`
      SELECT rt.id AS token_id, rt.family_id, rt.revoked_at, rt.expires_at < now() AS expired,
             rt.used_at, rt.used_at > now() - make_interval(secs => ${opts.graceSec}) AS in_grace,
             u.id, u.display_name, u.email, u.email_verified
      FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = ${hash(token)}
      FOR UPDATE OF rt`;
    if (!row) return { ok: false, reason: "unknown" };
    if (row.revoked_at || row.expired) return { ok: false, reason: "expired" };
    if (row.used_at && !row.in_grace) {
      await tx`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = ${row.family_id} AND revoked_at IS NULL`;
      return { ok: false, reason: "reused" };
    }
    if (!row.used_at) await tx`UPDATE refresh_tokens SET used_at = now() WHERE id = ${row.token_id}`;
    const user = toUser(row);
    const next = await insertToken(tx, user.id, row.family_id, opts.ttlDays, opts.userAgent?.slice(0, 256) ?? null);
    return { ok: true, user, token: next };
  });
}

/** Logs this device out: revokes the token's whole family. */
export async function revokeRefresh(sql: SQL, token: string): Promise<void> {
  await sql`
    UPDATE refresh_tokens SET revoked_at = now()
    WHERE revoked_at IS NULL
      AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = ${hash(token)})`;
}

/** Drops tokens that expired or were revoked more than a day ago. */
export async function pruneRefresh(sql: SQL): Promise<number> {
  const rows = await sql`
    DELETE FROM refresh_tokens
    WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'
    RETURNING id`;
  return rows.length;
}
