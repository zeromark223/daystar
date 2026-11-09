/**
 * Postgres, configured with the standard libpq variables (PGHOST, PGPORT,
 * PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE) that Bun.sql reads itself.
 * Optional: without PGHOST the server runs as before, with no accounts.
 */
import { SQL } from "bun";

export const dbConfigured = (): boolean => Boolean(process.env.PGHOST);

/** A connection pool, or null when no database is configured. */
export function openDb(options: ConstructorParameters<typeof SQL>[0] = {}): SQL | null {
  if (!dbConfigured()) return null;
  return new SQL({ max: 10, idleTimeout: 30, connectionTimeout: 10, ...options });
}
