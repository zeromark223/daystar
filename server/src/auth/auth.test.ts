/**
 * Logging in end to end against a fake Authentik (fake-oidc.ts) and the database
 * in .env (a throwaway schema, see db/test-db.ts). The database tests are skipped
 * without PGHOST; the pure ones always run.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dbConfigured } from "../db/db.ts";
import { createTestDb, type TestDb } from "../db/test-db.ts";
import { authConfigFromEnv, type AuthConfig } from "./config.ts";
import { startFakeOidc, type FakeOidc } from "./fake-oidc.ts";
import { signAccess, verifyAccess } from "./jwt.ts";
import { OidcClient } from "./oidc.ts";
import { createAuth, safeReturnPath, type Auth } from "./routes.ts";

const PUBLIC = "http://daystar.test";
const SECRET = "x".repeat(48);

/** The browser: keeps cookies across requests (paths ignored, Max-Age=0 deletes). */
class Browser {
  jar = new Map<string, string>();
  private readonly auth: Auth;
  constructor(auth: Auth) {
    this.auth = auth;
  }
  async send(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await this.auth.handle(new Request(PUBLIC + path, { ...init, headers }));
    for (const line of res.headers.getSetCookie()) {
      const c = Bun.Cookie.parse(line);
      if (c.maxAge === 0) this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
    return res;
  }
  post = (path: string, headers: Record<string, string> = { origin: PUBLIC }) => this.send(path, { method: "POST", headers });
}

describe("accounts", { skip: !dbConfigured() && "PGHOST is not set" }, () => {
  let db: TestDb;
  let fake: FakeOidc;
  let config: AuthConfig;
  let auth: Auth;

  before(async () => {
    db = await createTestDb({ migrate: true });
    fake = await startFakeOidc();
    config = {
      issuer: fake.issuer,
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
      redirectUri: `${PUBLIC}/api/auth/callback`,
      publicUrl: PUBLIC,
      jwtSecret: SECRET,
      accessTtlSec: 900,
      refreshTtlDays: 30,
      refreshGraceSec: 0,
    };
    auth = authWith({});
  });

  after(async () => {
    await fake?.stop();
    await db?.drop();
  });

  const authWith = (over: Partial<AuthConfig>) => {
    const c = { ...config, ...over };
    return createAuth(c, db.sql, new OidcClient(c));
  };

  /** Login up to Authentik's redirect back: the callback URL to visit. */
  async function startLogin(b: Browser, claims: Parameters<FakeOidc["authorize"]>[1], returnTo = "/r/calm-orbit-abc234") {
    const res = await b.send(`/api/auth/login?return=${encodeURIComponent(returnTo)}`);
    assert.equal(res.status, 302);
    const { code, state } = fake.authorize(res.headers.get("location")!, claims);
    return `/api/auth/callback?code=${code}&state=${state}`;
  }

  async function signIn(claims: Parameters<FakeOidc["authorize"]>[1] = {}, a = auth) {
    const b = new Browser(a);
    const res = await b.send(await startLogin(b, claims));
    assert.equal(res.status, 302);
    return { b, res };
  }

  test("login sets the session cookies and goes back to the room", async () => {
    const { b, res } = await signIn({ sub: "sub-ana", email: "ana@example.com", email_verified: true, name: "Ana" });
    assert.equal(res.headers.get("location"), "/r/calm-orbit-abc234");
    assert.deepEqual([...b.jar.keys()].sort(), ["ds_at", "ds_rt"]);
    const me = await b.send("/api/auth/me");
    const body = (await me.json()) as { user: { name: string; email: string; emailVerified: boolean } };
    assert.deepEqual({ ...body.user, id: undefined }, { id: undefined, name: "Ana", email: "ana@example.com", emailVerified: true });
  });

  test("logging in again is the same account, with the new profile", async () => {
    const first = await signIn({ sub: "sub-bo", name: "Bo" });
    const second = await signIn({ sub: "sub-bo", name: "Bo Tran", preferred_username: "bo" });
    const a = (await (await first.b.send("/api/auth/me")).json()) as { user: { id: string } };
    const b = (await (await second.b.send("/api/auth/me")).json()) as { user: { id: string; name: string } };
    assert.equal(a.user.id, b.user.id);
    assert.equal(b.user.name, "Bo Tran");
    const [row] = await db.sql`SELECT count(*)::int AS n FROM users WHERE authentik_sub = 'sub-bo'`;
    assert.equal(row.n, 1);
  });

  test("refresh swaps both cookies; a used refresh token revokes the family", async () => {
    const { b } = await signIn({ sub: "sub-cy" });
    const stolen = b.jar.get("ds_rt")!;
    const res = await b.post("/api/auth/refresh");
    assert.equal(res.status, 200);
    assert.notEqual(b.jar.get("ds_rt"), stolen);
    const { expiresAt } = (await res.json()) as { expiresAt: number };
    assert.ok(expiresAt > Date.now() + 800_000);

    // The thief replays the old token: refused, and the owner's new one dies with it.
    const thief = new Browser(auth);
    thief.jar.set("ds_rt", stolen);
    assert.equal((await thief.post("/api/auth/refresh")).status, 401);
    assert.equal((await b.post("/api/auth/refresh")).status, 401);
    assert.equal(b.jar.has("ds_rt"), false);
  });

  test("two tabs refreshing at once both stay signed in (grace)", async () => {
    const lenient = authWith({ refreshGraceSec: 10 });
    const { b } = await signIn({ sub: "sub-di" }, lenient);
    const tab2 = new Browser(lenient);
    tab2.jar = new Map(b.jar);
    const [r1, r2] = await Promise.all([b.post("/api/auth/refresh"), tab2.post("/api/auth/refresh")]);
    assert.deepEqual([r1.status, r2.status], [200, 200]);
    assert.equal((await b.post("/api/auth/refresh")).status, 200);
  });

  test("logout revokes the refresh token and clears the cookies", async () => {
    const { b } = await signIn({ sub: "sub-ed" });
    const token = b.jar.get("ds_rt")!;
    const res = await b.post("/api/auth/logout");
    const { endSessionUrl } = (await res.json()) as { endSessionUrl: string };
    assert.match(endSessionUrl, /\/end-session$/);
    assert.equal(b.jar.size, 0);
    b.jar.set("ds_rt", token);
    assert.equal((await b.post("/api/auth/refresh")).status, 401);
  });

  test("posts from other sites are refused", async () => {
    const { b } = await signIn({ sub: "sub-fa" });
    assert.equal((await b.post("/api/auth/refresh", { origin: "https://evil.example" })).status, 403);
    assert.equal((await b.post("/api/auth/logout", { origin: "https://evil.example" })).status, 403);
  });

  test("never redirects off the site", async () => {
    const b = new Browser(auth);
    const res = await b.send(await startLogin(b, { sub: "sub-gi" }, "//evil.example/x"));
    assert.equal(res.headers.get("location"), "/");
  });

  /** A callback that must fail with `code`, sending no session. */
  async function rejected(b: Browser, path: string, code: string) {
    const res = await b.send(path);
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get("location")!, PUBLIC).searchParams.get("auth_error"), code);
    assert.equal(b.jar.has("ds_at"), false);
    assert.equal(b.jar.has("ds_rt"), false);
  }

  test("callback: no login in progress, wrong state, or cancelled on Authentik", async () => {
    const b = new Browser(auth);
    await rejected(b, "/api/auth/callback?code=x&state=y", "expired");
    const path = await startLogin(b, { sub: "sub-ha" });
    await rejected(b, path.replace(/state=[^&]+/, "state=forged"), "state");
    const c = new Browser(auth);
    const state = new URLSearchParams((await startLogin(c, { sub: "sub-ha" })).split("?")[1]).get("state");
    await rejected(c, `/api/auth/callback?error=access_denied&state=${state}`, "access_denied");
  });

  test("callback: id_tokens that are not right are refused", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, (claims: any) => Promise<string>][] = [
      ["wrong nonce", (c) => fake.sign({ ...c, nonce: "other" })],
      ["another client", (c) => fake.sign({ ...c, aud: "someone-else" })],
      ["another issuer", (c) => fake.sign({ ...c, iss: "https://evil.example/" })],
      ["expired", (c) => fake.sign({ ...c, iat: now - 3600, exp: now - 600 })],
      ["unknown key", (c) => fake.sign(c, { alg: "RS256", kid: "k1" }, fake.strangerKey)],
      ["alg none", async (c) => (await fake.sign(c, { alg: "none", kid: "k1" })).replace(/[^.]+$/, "")],
      ["HS256", (c) => fake.sign(c, { alg: "HS256", kid: "k1" })],
    ];
    for (const [name, forge] of cases) {
      const b = new Browser(auth);
      const path = await startLogin(b, { sub: `sub-${name}` });
      fake.nextIdToken = forge;
      await rejected(b, path, "failed");
      const [row] = await db.sql`SELECT count(*)::int AS n FROM users WHERE authentik_sub = ${`sub-${name}`}`;
      assert.equal(row.n, 0, name);
    }
  });

  test("a code works once", async () => {
    const b = new Browser(auth);
    const path = await startLogin(b, { sub: "sub-io" });
    const flow = b.jar.get("ds_oidc")!;
    assert.equal((await b.send(path)).status, 302);
    const replay = new Browser(auth);
    replay.jar.set("ds_oidc", flow);
    await rejected(replay, path, "failed");
  });
});

test("access tokens: signed, expiring, tied to the secret", () => {
  const { token } = signAccess({ sub: "7", name: "A", email: null, ev: false }, SECRET, 60, 1_000_000);
  assert.equal(verifyAccess(token, SECRET, 1_000_000)?.sub, "7");
  assert.equal(verifyAccess(token, SECRET, 1_000_000 + 61_000), null);
  assert.equal(verifyAccess(token, "y".repeat(48), 1_000_000), null);
  const [h, p, s] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "1", exp: 9e9 })).toString("base64url");
  assert.equal(verifyAccess(`${h}.${forged}.${s}`, SECRET, 1_000_000), null);
  assert.equal(verifyAccess(`${h}.${p}`, SECRET, 1_000_000), null);
});

test("return paths stay on the site", () => {
  assert.equal(safeReturnPath("/r/calm-orbit-abc234?x=1#y"), "/r/calm-orbit-abc234?x=1#y");
  for (const bad of [null, "", "https://evil.example", "//evil.example", "/\\evil.example", "r/x", "javascript:alert(1)"]) {
    assert.equal(safeReturnPath(bad), "/", String(bad));
  }
});

test("config: off without an issuer, loud when half set up", () => {
  const full = {
    OIDC_ISSUER: "https://auth.example/application/o/daystar/",
    OIDC_CLIENT_ID: "id",
    OIDC_CLIENT_SECRET: "secret",
    OIDC_REDIRECT_URI: "https://daystar.example/api/auth/callback",
    PUBLIC_URL: "https://daystar.example",
    AUTH_JWT_SECRET: SECRET,
    PGHOST: "db",
  };
  assert.equal(authConfigFromEnv({}), null);
  assert.equal(authConfigFromEnv(full)?.publicUrl, "https://daystar.example");
  assert.throws(() => authConfigFromEnv({ ...full, PGHOST: undefined }), /PGHOST/);
  assert.throws(() => authConfigFromEnv({ ...full, AUTH_JWT_SECRET: "short" }), /32/);
  assert.throws(() => authConfigFromEnv({ ...full, PUBLIC_URL: "http://localhost:5173" }), /must be on PUBLIC_URL/);
});
