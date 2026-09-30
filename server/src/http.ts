/** Small HTTP helpers shared by the game server and the agent. */

// GET /api/health requires "Authorization: Bearer <HEALTH_TOKEN>" (or ?token=) when set.
const HEALTH_TOKEN = process.env.HEALTH_TOKEN ?? "";

/** A 401 response when HEALTH_TOKEN is set and the request lacks it, else null. */
export function rejectWithoutHealthToken(req: Request, url: URL): Response | null {
  if (!HEALTH_TOKEN) return null;
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
  if (constantTimeEqual(given, HEALTH_TOKEN)) return null;
  return new Response("Unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
}

/**
 * Optional HTTPS, e.g. to test voice from a phone on the LAN (browsers only allow
 * the microphone and WebCodecs on secure pages): TLS_CERT and TLS_KEY are paths
 * to PEM files. Standalone only; in production the proxy (Coolify) terminates TLS.
 */
export function tlsFromEnv(): { cert: ReturnType<typeof Bun.file>; key: ReturnType<typeof Bun.file> } | undefined {
  const cert = process.env.TLS_CERT;
  const key = process.env.TLS_KEY;
  if (!cert && !key) return undefined;
  if (!cert || !key) throw new Error("Set both TLS_CERT and TLS_KEY (or neither)");
  return { cert: Bun.file(cert), key: Bun.file(key) };
}

/** "https" when tlsFromEnv() is set, for startup messages. */
export const scheme = () => (tlsFromEnv() ? "https" : "http");

/** Request body as text, or null once it exceeds `limit` bytes. */
export async function readLimited(req: Request, limit: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** JSON body `{ room }` of /api/join, validated, or null. */
export async function readJoinRequest(req: Request, pattern: RegExp): Promise<string | null> {
  const body = await readLimited(req, 1024);
  if (body === null) return null;
  try {
    const { room } = JSON.parse(body) as { room?: unknown };
    return typeof room === "string" && pattern.test(room) ? room : null;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
