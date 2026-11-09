/**
 * A standalone server end to end: /api/join puts the signed-in account in a join
 * ticket, and the WebSocket upgrade checks it (and the Origin). Starts the real
 * server with accounts on; skipped without a database (PGHOST).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Subprocess } from "bun";
import { encodeClientMessage, decodeServerMessage } from "../../../shared/src/protocol.ts";
import { dbConfigured } from "../db/db.ts";
import { newRoomId } from "../host-key.ts";
import { signAccess } from "./jwt.ts";

const SECRET = "j".repeat(48);
const PUBLIC = "http://daystar.test";

describe("joining as an account", { skip: !dbConfigured() && "PGHOST is not set" }, () => {
  let server: Subprocess;
  let base: string;
  const room = newRoomId();

  before(async () => {
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    base = `http://127.0.0.1:${port}`;
    server = Bun.spawn(["bun", "server/src/main.ts"], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        CLUSTER_SERVERS: "0",
        ROOM_SECRET: "room-secret-for-tests",
        PUBLIC_URL: PUBLIC,
        OIDC_ISSUER: "http://127.0.0.1:1/application/o/daystar/",
        OIDC_CLIENT_ID: "id",
        OIDC_CLIENT_SECRET: "secret",
        OIDC_REDIRECT_URI: `${PUBLIC}/api/auth/callback`,
        AUTH_JWT_SECRET: SECRET,
      },
      stdout: "ignore",
      stderr: "inherit",
    });
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) return;
      await Bun.sleep(50);
    }
    throw new Error("server did not start");
  });

  after(() => {
    server?.kill();
  });

  async function join(cookie?: string): Promise<string> {
    const res = await fetch(`${base}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ room }),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as { wsUrl: string }).wsUrl;
  }

  const signedIn = () => `ds_at=${signAccess({ sub: "42", name: "Ana", email: null, ev: true }, SECRET, 60).token}`;

  /** Opens the socket and joins: "welcome", or why it failed. `stay` keeps it open. */
  function connect(wsUrl: string, headers: Record<string, string> = {}, opts: { hostKey?: string; stay?: WebSocket[] } = {}): Promise<string> {
    const ws = new WebSocket(`${base.replace("http", "ws")}${wsUrl}`, { headers } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    return new Promise((resolve) => {
      ws.onopen = () => ws.send(encodeClientMessage({ t: "join", name: "Ana", appearance: 0, hostKey: opts.hostKey ?? "" }));
      ws.onmessage = (e) => {
        const msg = decodeServerMessage(new Uint8Array(e.data as ArrayBuffer));
        if (msg?.t === "welcome") {
          if (opts.stay) opts.stay.push(ws);
          else ws.close();
          resolve("welcome");
        }
      };
      ws.onerror = () => resolve("refused");
    });
  }

  const ticketOf = (wsUrl: string) => new URL(wsUrl, base).searchParams.get("ticket");
  const payload = (ticket: string) => JSON.parse(Buffer.from(ticket.split(".")[0], "base64url").toString());

  test("guests get no ticket and still join", async () => {
    const wsUrl = await join();
    assert.equal(ticketOf(wsUrl), null);
    assert.equal(await connect(wsUrl), "welcome");
  });

  test("a signed-in player gets a ticket carrying the account, and joins with it", async () => {
    const wsUrl = await join(signedIn());
    const ticket = ticketOf(wsUrl)!;
    assert.deepEqual(payload(ticket), { ...payload(ticket), kind: "join", room, user: { id: "42", ev: true } });
    assert.equal(await connect(wsUrl), "welcome");
  });

  test("an expired access cookie joins as a guest", async () => {
    const stale = `ds_at=${signAccess({ sub: "42", name: null, email: null, ev: true }, SECRET, 60, Date.now() - 120_000).token}`;
    assert.equal(ticketOf(await join(stale)), null);
  });

  test("forged, foreign or misplaced tickets are refused", async () => {
    const wsUrl = await join(signedIn());
    const [body, mac] = ticketOf(wsUrl)!.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload(body + "."), user: { id: "1", ev: true } })).toString("base64url");
    assert.equal(await connect(wsUrl.replace(body, forged)), "refused");
    assert.equal(await connect(wsUrl.replace(mac, mac.slice(0, -2) + "xx")), "refused");
    // A ticket for one room does not open another.
    const other = newRoomId();
    assert.equal(await connect(wsUrl.replace(`room=${room}`, `room=${other}`)), "refused");
  });

  test("the account's live room, for 'rejoin?' on another device", async () => {
    const mine = async (cookie?: string) => {
      const res = await fetch(`${base}/api/rooms/mine`, { headers: cookie ? { cookie } : {} });
      return res.ok ? await res.json() : res.status;
    };
    assert.equal(await mine(), 401);
    assert.deepEqual(await mine(signedIn()), { room: null });
    const created = (await (await fetch(`${base}/api/rooms`, { method: "POST" })).json()) as { room: string; hostKey: string };
    const res = await fetch(`${base}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: signedIn() },
      body: JSON.stringify({ room: created.room }),
    });
    const { wsUrl } = (await res.json()) as { wsUrl: string };
    const open: WebSocket[] = [];
    assert.equal(await connect(wsUrl, {}, { hostKey: created.hostKey, stay: open }), "welcome");
    assert.deepEqual(await mine(signedIn()), { room: created.room, role: "host" });
    open.forEach((ws) => ws.close());
  });

  test("pages from other sites cannot open a socket", async () => {
    const wsUrl = await join();
    assert.equal(await connect(wsUrl, { origin: "https://evil.example" }), "refused");
    assert.equal(await connect(wsUrl, { origin: PUBLIC }), "welcome");
  });
});
