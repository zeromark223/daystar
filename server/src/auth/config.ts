/** Accounts configuration from the environment (see .env.example). */

export interface AuthConfig {
  /** Authentik's issuer for the Daystar provider, with its trailing slash. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Origin of the site (e.g. https://daystar.ptnn.dev): cookies, Origin checks, redirects. */
  publicUrl: string;
  /** Signs Daystar's access tokens and the login flow cookie. */
  jwtSecret: string;
  accessTtlSec: number;
  refreshTtlDays: number;
  /**
   * A refresh token presented again this soon after it was used is taken as a race
   * (two tabs refreshing at once), not theft: it gets a fresh token instead of
   * revoking the family.
   */
  refreshGraceSec: number;
}

const ACCOUNT_VARS = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI", "PUBLIC_URL", "AUTH_JWT_SECRET"];

/**
 * The accounts configuration, or null when accounts are off (no OIDC_ISSUER).
 * Throws when it is half set up, so a typo fails at startup rather than at login.
 */
export function authConfigFromEnv(env: Record<string, string | undefined> = process.env): AuthConfig | null {
  if (!env.OIDC_ISSUER) return null;
  const missing = ACCOUNT_VARS.filter((name) => !env[name]);
  if (!env.PGHOST) missing.push("PGHOST");
  if (missing.length) throw new Error(`accounts need ${missing.join(", ")} (see .env.example)`);
  const jwtSecret = env.AUTH_JWT_SECRET!;
  if (jwtSecret.length < 32) throw new Error("AUTH_JWT_SECRET must be at least 32 characters (openssl rand -base64 48)");
  const publicUrl = new URL(env.PUBLIC_URL!).origin;
  const redirect = new URL(env.OIDC_REDIRECT_URI!);
  if (redirect.origin !== publicUrl) {
    throw new Error(`OIDC_REDIRECT_URI (${redirect.origin}) must be on PUBLIC_URL (${publicUrl}): the login cookies live there`);
  }
  return {
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID!,
    clientSecret: env.OIDC_CLIENT_SECRET!,
    redirectUri: redirect.href,
    publicUrl,
    jwtSecret,
    accessTtlSec: positive(env.AUTH_ACCESS_TTL, 900),
    refreshTtlDays: positive(env.AUTH_REFRESH_TTL_DAYS, 30),
    refreshGraceSec: 10,
  };
}

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value ?? fallback);
  if (!(n > 0)) throw new Error(`expected a positive number, got ${value}`);
  return n;
}
