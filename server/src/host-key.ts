import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Rooms and their hosts, without storing anything: the server picks a fresh room
 * id and hands its creator a host key, HMAC(secret, room). Whoever presents the
 * key when joining is the host. Because the server chooses the id, nobody can
 * ask for the key of a room that already exists.
 *
 * Rooms opened by typing any /r/<id> still work; they simply have no host.
 */

const ADJECTIVES = ["amber", "bright", "calm", "cosmic", "golden", "lunar", "quiet", "radiant", "silver", "velvet"];
const NOUNS = ["comet", "nebula", "orbit", "aurora", "eclipse", "quasar", "zenith", "meteor", "galaxy", "halo"];
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function pick<T>(list: readonly T[], byte: number): T {
  return list[byte % list.length];
}

/** e.g. "golden-comet-k3x9q2": readable, with ~30 bits of randomness. */
export function newRoomId(): string {
  const r = randomBytes(8);
  let tail = "";
  for (let i = 2; i < 8; i++) tail += pick([...ALPHABET], r[i]);
  return `${pick(ADJECTIVES, r[0])}-${pick(NOUNS, r[1])}-${tail}`;
}

export function hostKeyFor(room: string, secret: string): string {
  return createHmac("sha256", secret).update(`host:${room}`).digest().subarray(0, 18).toString("base64url");
}

export function isHostKey(room: string, key: string, secret: string): boolean {
  const expected = Buffer.from(hostKeyFor(room, secret));
  const given = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The secret behind host keys: CLUSTER_SECRET in a cluster (the agent and every
 * server must agree), else ROOM_SECRET. Without either, a random one is made at
 * startup and host keys stop working after a restart.
 */
export function hostKeySecret(clusterSecret?: string): string {
  const secret = clusterSecret ?? process.env.ROOM_SECRET;
  if (secret) return secret;
  console.warn("warning: ROOM_SECRET is not set; hosts lose their rooms when the server restarts");
  return randomBytes(32).toString("base64url");
}

/** POST /api/rooms: a new room and its host key. */
export function createRoom(req: Request, secret: string): Response {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const room = newRoomId();
  return Response.json({ room, hostKey: hostKeyFor(room, secret) }, { headers: { "cache-control": "no-store" } });
}
