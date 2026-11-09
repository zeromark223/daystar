/**
 * A stand-in for Authentik in tests: discovery, JWKS and the token endpoint on a
 * random local port, signing id_tokens with a fresh RSA key. Tests play the
 * browser: they read the authorization URL Daystar built and ask for a code.
 */
import { pkceChallenge } from "./oidc.ts";
import { b64url, type IdClaims } from "./jwt.ts";

const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

export interface FakeOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Approves an authorization URL as a signed-in person: a code and the state to send back. */
  authorize(authorizeUrl: string, claims: Partial<IdClaims>): { code: string; state: string };
  /** Signs any claims and header (for broken tokens). */
  sign(claims: object, header?: object, key?: CryptoKey): Promise<string>;
  /** Replaces the next id_token the token endpoint hands out. */
  nextIdToken: ((claims: IdClaims) => Promise<string>) | null;
  /** A key the provider does not publish. */
  strangerKey: CryptoKey;
  stop(): Promise<void>;
}

export async function startFakeOidc(): Promise<FakeOidc> {
  const keys = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const stranger = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", use: "sig", alg: "RS256" };
  const codes = new Map<string, { claims: IdClaims; challenge: string; redirectUri: string }>();
  const clientId = "daystar-test";
  const clientSecret = "test-secret";
  let counter = 0;

  async function sign(claims: object, header: object = { alg: "RS256", kid: "k1", typ: "JWT" }, key = keys.privateKey) {
    const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body));
    return `${body}.${b64url(new Uint8Array(sig))}`;
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer: fake.issuer,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          jwks_uri: `${url.origin}/jwks`,
          end_session_endpoint: `${url.origin}/end-session`,
        });
      }
      if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if (url.pathname === "/token" && req.method === "POST") {
        const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
        if (req.headers.get("authorization") !== `Basic ${basic}`) return Response.json({ error: "invalid_client" }, { status: 401 });
        const form = new URLSearchParams(await req.text());
        const entry = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (!entry || form.get("grant_type") !== "authorization_code") return Response.json({ error: "invalid_grant" }, { status: 400 });
        if (pkceChallenge(form.get("code_verifier") ?? "") !== entry.challenge || form.get("redirect_uri") !== entry.redirectUri) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const override = fake.nextIdToken;
        fake.nextIdToken = null;
        const idToken = override ? await override(entry.claims) : await sign(entry.claims);
        return Response.json({ access_token: "unused", token_type: "Bearer", id_token: idToken });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const fake: FakeOidc = {
    issuer: `http://127.0.0.1:${server.port}/application/o/daystar/`,
    clientId,
    clientSecret,
    nextIdToken: null,
    strangerKey: stranger.privateKey,
    sign,
    authorize(authorizeUrl, claims) {
      const p = new URL(authorizeUrl).searchParams;
      if (p.get("client_id") !== clientId || p.get("code_challenge_method") !== "S256") throw new Error("bad authorize request");
      const now = Math.floor(Date.now() / 1000);
      const code = `code-${++counter}`;
      codes.set(code, {
        claims: { iss: fake.issuer, aud: clientId, iat: now, exp: now + 300, nonce: p.get("nonce")!, sub: "sub-1", ...claims },
        challenge: p.get("code_challenge")!,
        redirectUri: p.get("redirect_uri")!,
      });
      return { code, state: p.get("state")! };
    },
    stop: () => server.stop(true),
  };
  return fake;
}
