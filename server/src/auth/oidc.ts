/**
 * The OIDC client side of logging in with Authentik: discovery, the authorization
 * URL (code flow with PKCE S256), the code exchange and the issuer's signing keys.
 */
import { createHash } from "node:crypto";
import { b64url } from "./jwt.ts";

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

/** Don't refetch the JWKS more often than this for an unknown key id. */
const JWKS_REFETCH_MS = 60_000;

export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

export class OidcClient {
  private discovery: Promise<Discovery> | null = null;
  private keys = new Map<string, CryptoKey>();
  private keysFetchedAt = 0;

  private readonly opts: { issuer: string; clientId: string; clientSecret: string; redirectUri: string };
  private readonly fetchFn: typeof fetch;

  constructor(opts: { issuer: string; clientId: string; clientSecret: string; redirectUri: string }, fetchFn: typeof fetch = fetch) {
    this.opts = opts;
    this.fetchFn = fetchFn;
  }

  private config(): Promise<Discovery> {
    this.discovery ??= this.fetchJson<Discovery>(new URL(".well-known/openid-configuration", this.opts.issuer).href).then(
      (d) => {
        if (d.issuer !== this.opts.issuer) throw new Error(`OIDC_ISSUER is ${this.opts.issuer} but the provider says ${d.issuer}`);
        return d;
      },
    );
    // A failed discovery (Authentik down) is retried on the next login.
    this.discovery.catch(() => (this.discovery = null));
    return this.discovery;
  }

  async authorizeUrl(p: { state: string; nonce: string; verifier: string }): Promise<string> {
    const url = new URL((await this.config()).authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      scope: "openid email profile",
      state: p.state,
      nonce: p.nonce,
      code_challenge: pkceChallenge(p.verifier),
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }

  /** Trades an authorization code for the id_token (not yet verified). */
  async exchange(code: string, verifier: string): Promise<string> {
    const { token_endpoint } = await this.config();
    const basic = Buffer.from(`${encodeURIComponent(this.opts.clientId)}:${encodeURIComponent(this.opts.clientSecret)}`);
    const res = await this.fetchFn(token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic.toString("base64")}` },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.opts.redirectUri,
        code_verifier: verifier,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!res.ok || !body.id_token) throw new Error(`token exchange failed: ${res.status} ${body.error ?? ""}`.trim());
    return body.id_token;
  }

  /** The issuer's RS256 key `kid`; an unknown id refetches the JWKS (key rotation). */
  async key(kid: string | undefined): Promise<CryptoKey | null> {
    const id = kid ?? "";
    if (!this.keys.has(id) && Date.now() - this.keysFetchedAt > JWKS_REFETCH_MS) {
      this.keysFetchedAt = Date.now();
      const { jwks_uri } = await this.config();
      const { keys } = await this.fetchJson<{ keys: (JsonWebKey & { kid?: string; use?: string })[] }>(jwks_uri);
      const fresh = new Map<string, CryptoKey>();
      for (const jwk of keys) {
        if (jwk.kty !== "RSA" || (jwk.use && jwk.use !== "sig")) continue;
        const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        fresh.set(jwk.kid ?? "", key);
      }
      this.keys = fresh;
    }
    return this.keys.get(id) ?? null;
  }

  async endSessionUrl(): Promise<string | null> {
    return (await this.config()).end_session_endpoint ?? null;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await this.fetchFn(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
    return (await res.json()) as T;
  }
}
