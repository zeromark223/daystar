import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload)).
 * The agent issues player tickets; servers mint server tokens to authenticate to
 * the agent and to each other. All share CLUSTER_SECRET.
 *
 * Future (docs/cluster.md): tickets are not single-use, replay is only bounded
 * by `exp`; add a nonce cache on servers if that ever matters.
 */

/** Lets a client connect to one server as one player of one room. */
export interface PlayerTicket {
  kind: "player";
  room: string;
  server: number;
  /** Player id, unique within the room, allocated by the agent. */
  player: number;
  /** Unix epoch ms after which the ticket cannot be used to connect. */
  exp: number;
  /** Set on migration tickets: the server the player is leaving. */
  from?: number;
}

/** Proves a connection comes from a cluster server (agent link, mesh). */
export interface ServerToken {
  kind: "server";
  server: number;
  exp: number;
}

export type Token = PlayerTicket | ServerToken;

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

function mac(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function sign(token: Token, secret: string): string {
  const body = b64url(JSON.stringify(token));
  return `${body}.${mac(body, secret).toString("base64url")}`;
}

/**
 * Returns the payload when the signature is valid and, unless `allowExpired`,
 * the token has not expired; null otherwise.
 */
export function verify(value: string, secret: string, opts: { now?: number; allowExpired?: boolean } = {}): Token | null {
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), "base64url");
  const expected = mac(body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let token: Token;
  try {
    token = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof token !== "object" || token === null || typeof token.exp !== "number") return null;
  if (!opts.allowExpired && token.exp < (opts.now ?? Date.now())) return null;
  return token;
}

export function verifyPlayer(value: string, secret: string, opts?: { now?: number; allowExpired?: boolean }): PlayerTicket | null {
  const token = verify(value, secret, opts);
  return token?.kind === "player" ? token : null;
}

export function verifyServer(value: string, secret: string, opts?: { now?: number }): ServerToken | null {
  const token = verify(value, secret, opts);
  return token?.kind === "server" ? token : null;
}

/** A short-lived token for server-to-agent and server-to-server connections. */
export function serverToken(server: number, secret: string): string {
  return sign({ kind: "server", server, exp: Date.now() + 60_000 }, secret);
}
