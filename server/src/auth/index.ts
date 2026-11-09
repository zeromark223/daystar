/**
 * Accounts (docs: README "Accounts"): log in with Authentik, Daystar's own JWT
 * sessions in Postgres. Off unless OIDC_ISSUER is set; guests never need them.
 */
import { openDb } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { authConfigFromEnv } from "./config.ts";
import { OidcClient } from "./oidc.ts";
import { createAuth, type Auth } from "./routes.ts";
import { pruneRefresh } from "./sessions.ts";

export type { Auth } from "./routes.ts";

const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** Accounts from the environment, migrating the database first; null when off. */
export async function authFromEnv(): Promise<Auth | null> {
  const config = authConfigFromEnv();
  if (!config) {
    console.log("accounts: off (set OIDC_ISSUER and PGHOST to turn them on, see example.env)");
    return null;
  }
  const sql = openDb()!;
  const applied = await migrate(sql);
  if (applied.length) console.log(`database: applied ${applied.join(", ")}`);
  const oidc = new OidcClient(config);
  setInterval(() => void pruneRefresh(sql).catch((err) => console.error("pruning refresh tokens:", err)), PRUNE_EVERY_MS).unref();
  console.log(`accounts: on (${config.issuer}, database ${process.env.PGDATABASE ?? "?"})`);
  return createAuth(config, sql, oidc);
}
