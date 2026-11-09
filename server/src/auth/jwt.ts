/**
 * The two kinds of JWT accounts deal with, without a library:
 * - Daystar's own access tokens (HS256 with AUTH_JWT_SECRET), checked on every
 *   authenticated request with no database round trip;
 * - Authentik's id_tokens (RS256, keys from its JWKS), checked once at login.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const enc = new TextEncoder();
export const b64url = (data: Uint8Array | string) => Buffer.from(data).toString("base64url");
const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

/** What the browser's access cookie says about its user. */
export interface AccessClaims {
  /** users.id */
  sub: string;
  name: string | null;
  email: string | null;
  /** Authentik vouches for the email (domain-only rooms rely on it). */
  ev: boolean;
  iat: number;
  exp: number;
}

const HS256_HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function hs256(input: string, secret: string): string {
  return createHmac("sha256", secret).update(`access:${input}`).digest("base64url");
}

export function signAccess(
  claims: Omit<AccessClaims, "iat" | "exp">,
  secret: string,
  ttlSec: number,
  now = Date.now(),
): { token: string; exp: number } {
  const iat = Math.floor(now / 1000);
  const exp = iat + ttlSec;
  const body = `${HS256_HEADER}.${b64url(JSON.stringify({ ...claims, iat, exp }))}`;
  return { token: `${body}.${hs256(body, secret)}`, exp };
}

export function verifyAccess(token: string, secret: string, now = Date.now()): AccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== HS256_HEADER) return null;
  const expected = Buffer.from(hs256(`${parts[0]}.${parts[1]}`, secret));
  const given = Buffer.from(parts[2]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as AccessClaims;
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    return claims.exp > now / 1000 ? claims : null;
  } catch {
    return null;
  }
}

/** The claims Daystar reads from an Authentik id_token. */
export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
}

export interface IdTokenCheck {
  /** The issuer's signing key with this id (refetching the JWKS if unknown), or null. */
  key(kid: string | undefined): Promise<CryptoKey | null>;
  issuer: string;
  audience: string;
  nonce: string;
  now?: number;
  /** Clock difference tolerated between Authentik and this server. */
  leewaySec?: number;
}

/** Verified id_token claims; throws (with a reason) when anything is off. */
export async function verifyIdToken(token: string, check: IdTokenCheck): Promise<IdClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("id_token is not a JWT");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString()) as { alg?: string; kid?: string };
  // Pinning the algorithm stops "alg: none" and HS256-with-the-public-key tricks.
  if (header.alg !== "RS256") throw new Error(`id_token alg ${header.alg} is not RS256`);
  const key = await check.key(header.kid);
  if (!key) throw new Error(`no signing key ${header.kid}`);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromB64url(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new Error("id_token signature is invalid");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as IdClaims;
  const now = (check.now ?? Date.now()) / 1000;
  const leeway = check.leewaySec ?? 60;
  if (claims.iss !== check.issuer) throw new Error(`id_token issuer ${claims.iss} is not ${check.issuer}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(check.audience)) throw new Error("id_token is for another client");
  if (!(claims.exp + leeway > now)) throw new Error("id_token has expired");
  if (!(claims.iat - leeway <= now)) throw new Error("id_token is from the future");
  if (claims.nonce !== check.nonce) throw new Error("id_token nonce does not match");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("id_token has no subject");
  return claims;
}
