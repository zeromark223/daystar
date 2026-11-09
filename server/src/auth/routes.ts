/**
 * /api/auth/*: logging in with Authentik and Daystar's own sessions.
 *
 *   GET  /api/auth/login?return=/r/<room>   → Authentik (code flow, PKCE, state, nonce)
 *   GET  /api/auth/callback                 → sets the cookies, back to `return`
 *   POST /api/auth/refresh                  → new access + refresh cookies   { user, expiresAt }
 *   POST /api/auth/logout                   → revokes this device's tokens   { endSessionUrl }
 *   GET  /api/auth/me                       → { user, expiresAt } or 401
 *
 * Cookies (all HttpOnly, SameSite=Lax, Secure on https):
 *   ds_at    access JWT, path /, lives AUTH_ACCESS_TTL
 *   ds_rt    refresh token, path /api/auth, lives AUTH_REFRESH_TTL_DAYS
 *   ds_oidc  the login in progress (state, nonce, PKCE verifier), path /api/auth/callback, 10 min
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SQL } from "bun";
import type { AuthConfig } from "./config.ts";
import { signAccess, verifyAccess, type AccessClaims } from "./jwt.ts";
import { verifyIdToken } from "./jwt.ts";
import type { OidcClient } from "./oidc.ts";
import { issueRefresh, revokeRefresh, rotateRefresh, upsertUser, type User } from "./sessions.ts";

export const ACCESS_COOKIE = "ds_at";
export const REFRESH_COOKIE = "ds_rt";
const FLOW_COOKIE = "ds_oidc";
const FLOW_TTL_SEC = 600;
const NO_STORE = { "cache-control": "no-store" };

interface Flow {
  /** state */
  s: string;
  /** nonce */
  n: string;
  /** PKCE verifier */
  v: string;
  /** where to go back to */
  r: string;
}

export interface Auth {
  /** Answers any /api/auth/* request. */
  handle(req: Request): Promise<Response>;
  /** The signed-in user behind a request's access cookie, or null. */
  userFrom(req: Request): AccessClaims | null;
}

/** Only same-site paths: "/r/x" yes; "//evil.com", "https://…", "/\evil" no. */
export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  try {
    const url = new URL(value, "http://daystar.invalid");
    return url.origin === "http://daystar.invalid" ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

export function createAuth(config: AuthConfig, sql: SQL, oidc: OidcClient): Auth {
  const secure = config.publicUrl.startsWith("https:");
  const flowKey = createHmac("sha256", config.jwtSecret).update("oidc-flow").digest();

  const cookie = (name: string, value: string, path: string, maxAge: number) =>
    new Bun.Cookie(name, value, { path, maxAge, httpOnly: true, secure, sameSite: "lax" }).serialize();
  const clear = (name: string, path: string) => cookie(name, "", path, 0);

  const sealFlow = (flow: Flow) => {
    const body = Buffer.from(JSON.stringify(flow)).toString("base64url");
    return `${body}.${createHmac("sha256", flowKey).update(body).digest("base64url")}`;
  };
  const openFlow = (value: string | null): Flow | null => {
    const [body, mac] = (value ?? "").split(".");
    if (!body || !mac) return null;
    const expected = Buffer.from(createHmac("sha256", flowKey).update(body).digest("base64url"));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString()) as Flow;
    } catch {
      return null;
    }
  };

  /** Cookies for a signed-in user: a fresh access JWT and (when given) the refresh token. */
  function sessionCookies(user: User, refresh: string): { headers: Headers; expiresAt: number } {
    const { token, exp } = signAccess(
      { sub: user.id, name: user.name, email: user.email, ev: user.emailVerified },
      config.jwtSecret,
      config.accessTtlSec,
    );
    const headers = new Headers(NO_STORE);
    headers.append("set-cookie", cookie(ACCESS_COOKIE, token, "/", config.accessTtlSec));
    headers.append("set-cookie", cookie(REFRESH_COOKIE, refresh, "/api/auth", config.refreshTtlDays * 86_400));
    return { headers, expiresAt: exp * 1000 };
  }

  const cookies = (req: Request) => new Bun.CookieMap(req.headers.get("cookie") ?? "");

  /**
   * POSTs carry cookies only from our own pages (SameSite=Lax); the Origin check
   * also stops other sites' forms and fetches.
   */
  const fromOtherSite = (req: Request) => {
    const origin = req.headers.get("origin");
    return origin !== null && origin !== config.publicUrl;
  };

  function redirect(location: string, headers = new Headers(NO_STORE)): Response {
    headers.set("location", location);
    return new Response(null, { status: 302, headers });
  }

  async function login(url: URL): Promise<Response> {
    const flow: Flow = {
      s: randomBytes(16).toString("base64url"),
      n: randomBytes(16).toString("base64url"),
      v: randomBytes(32).toString("base64url"),
      r: safeReturnPath(url.searchParams.get("return")),
    };
    const target = await oidc.authorizeUrl({ state: flow.s, nonce: flow.n, verifier: flow.v });
    const headers = new Headers(NO_STORE);
    headers.append("set-cookie", cookie(FLOW_COOKIE, sealFlow(flow), "/api/auth/callback", FLOW_TTL_SEC));
    return redirect(target, headers);
  }

  async function callback(req: Request, url: URL): Promise<Response> {
    const flow = openFlow(cookies(req).get(FLOW_COOKIE));
    const fail = (code: string, detail?: unknown) => {
      if (detail) console.warn(`login failed (${code}):`, detail instanceof Error ? detail.message : detail);
      const back = new URL(flow?.r ?? "/", "http://daystar.invalid");
      back.searchParams.set("auth_error", code);
      const headers = new Headers(NO_STORE);
      headers.append("set-cookie", clear(FLOW_COOKIE, "/api/auth/callback"));
      return redirect(back.pathname + back.search + back.hash, headers);
    };
    if (!flow) return fail("expired");
    const state = url.searchParams.get("state");
    if (!state || state !== flow.s) return fail("state");
    // e.g. access_denied when the person cancels on Authentik's page.
    const providerError = url.searchParams.get("error");
    if (providerError) return fail(providerError.replace(/[^a-z_]/g, "").slice(0, 32) || "denied");
    const code = url.searchParams.get("code");
    if (!code) return fail("code");
    let user: User;
    try {
      const idToken = await oidc.exchange(code, flow.v);
      const claims = await verifyIdToken(idToken, {
        key: (kid) => oidc.key(kid),
        issuer: config.issuer,
        audience: config.clientId,
        nonce: flow.n,
      });
      user = await upsertUser(sql, claims);
    } catch (err) {
      return fail("failed", err);
    }
    const refresh = await issueRefresh(sql, user.id, config.refreshTtlDays, req.headers.get("user-agent"));
    const { headers } = sessionCookies(user, refresh);
    headers.append("set-cookie", clear(FLOW_COOKIE, "/api/auth/callback"));
    return redirect(flow.r, headers);
  }

  async function refresh(req: Request): Promise<Response> {
    const token = cookies(req).get(REFRESH_COOKIE);
    if (!token) return signedOut();
    const result = await rotateRefresh(sql, token, {
      ttlDays: config.refreshTtlDays,
      graceSec: config.refreshGraceSec,
      userAgent: req.headers.get("user-agent"),
    });
    if (!result.ok) {
      if (result.reason === "reused") console.warn("refresh token reused; its family is revoked");
      return signedOut();
    }
    const { headers, expiresAt } = sessionCookies(result.user, result.token);
    return Response.json({ user: result.user, expiresAt }, { headers });
  }

  async function logout(req: Request): Promise<Response> {
    const token = cookies(req).get(REFRESH_COOKIE);
    if (token) await revokeRefresh(sql, token);
    const headers = clearedSession();
    return Response.json({ endSessionUrl: await oidc.endSessionUrl().catch(() => null) }, { headers });
  }

  function me(req: Request): Response {
    const claims = userFromReq(req);
    if (!claims) return new Response("Signed out", { status: 401, headers: NO_STORE });
    const user: User = { id: claims.sub, name: claims.name, email: claims.email, emailVerified: claims.ev };
    return Response.json({ user, expiresAt: claims.exp * 1000 }, { headers: NO_STORE });
  }

  function clearedSession(): Headers {
    const headers = new Headers(NO_STORE);
    headers.append("set-cookie", clear(ACCESS_COOKIE, "/"));
    headers.append("set-cookie", clear(REFRESH_COOKIE, "/api/auth"));
    return headers;
  }

  const signedOut = () => new Response("Signed out", { status: 401, headers: clearedSession() });

  function userFromReq(req: Request): AccessClaims | null {
    const token = cookies(req).get(ACCESS_COOKIE);
    return token ? verifyAccess(token, config.jwtSecret) : null;
  }

  return {
    userFrom: userFromReq,
    async handle(req) {
      const url = new URL(req.url);
      const route = `${req.method} ${url.pathname}`;
      if (req.method === "POST" && fromOtherSite(req)) return new Response("Forbidden", { status: 403 });
      switch (route) {
        case "GET /api/auth/login":
          return await login(url);
        case "GET /api/auth/callback":
          return await callback(req, url);
        case "POST /api/auth/refresh":
          return await refresh(req);
        case "POST /api/auth/logout":
          return await logout(req);
        case "GET /api/auth/me":
          return me(req);
        default:
          return new Response("Not found", { status: 404 });
      }
    },
  };
}
