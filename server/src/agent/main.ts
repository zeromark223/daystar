/**
 * Cluster agent (docs/cluster.md): serves the web client, tells each joining
 * client which game server to connect to (with a signed ticket), and watches
 * server load.
 *
 * SINGLE POINT OF FAILURE, on purpose for now: there is exactly one agent. If it
 * is down nobody can join or move and the system is considered down. Several
 * agents behind a load balancer (shared registry state) are future work.
 */
import { ROOM_ID_PATTERN } from "../../../shared/src/constants.ts";
import type { AgentToServer, ServerToAgent } from "../cluster/control.ts";
import { sign, verifyPlayer, verifyServer } from "../cluster/ticket.ts";
import { createRoom } from "../host-key.ts";
import { readJoinRequest, readLimited, rejectWithoutHealthToken } from "../http.ts";
import { CLIENT_DIR } from "../paths.ts";
import { createStaticHandler, warnIfClientMissing } from "../static.ts";
import type { StatsSample } from "../stats.ts";
import { HARD_LIMIT } from "./placement.ts";
import { Registry } from "./registry.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const SECRET = process.env.CLUSTER_SECRET ?? "";
if (!SECRET) throw new Error("The agent needs CLUSTER_SECRET");

/** How long a client has to connect with its ticket. */
const TICKET_TTL_MS = 30_000;
/** Rooms may span several servers; their servers sync over the mesh. */
const ALLOW_SPAN = true;
const HISTORY = 300;

// Overload handling (docs/cluster.md "Placement"): a server is hot above the hard
// limit, or when its loop p99 stays above LOOP_P99_HOT_MS for HOT_SAMPLES seconds.
const LOOP_P99_HOT_MS = 40;
const HOT_SAMPLES = 5;
/** Share of a hot server's players asked to move per order. */
const SHED_RATIO = 0.1;
/** Minimum time between two orders to the same server (hysteresis). */
const ORDER_COOLDOWN_MS = 30_000;
const lastOrder = new Map<number, number>();

const registry = new Registry();
/** Current control socket per server id. */
const links = new Map<number, Bun.ServerWebSocket<LinkData>>();
const serveStatic = createStaticHandler(CLIENT_DIR);
const startedAt = Date.now();
const runtime = `bun ${Bun.version} (agent)`;

interface LinkData {
  server: number;
}

function tell(server: number, msg: AgentToServer): void {
  links.get(server)?.send(JSON.stringify(msg));
}

/** Every live server learns about every other one (mesh, milestone 3). */
function broadcastPeers(): void {
  const peers = registry.liveServers().map((s) => ({ server: s.server, meshUrl: s.meshUrl }));
  for (const server of links.keys()) tell(server, { t: "peers", peers });
}

function onLinkMessage(server: number, msg: ServerToAgent): void {
  switch (msg.t) {
    case "register": {
      const { t: _t, players, ...info } = msg;
      if (info.server !== server) return; // token and payload disagree
      registry.register(info, players);
      console.log(`server ${server} registered (${info.publicUrl}, capacity ${info.capacity}, ${players.length} players)`);
      broadcastPeers();
      break;
    }
    case "joined":
      registry.joined(server, msg.room, msg.player);
      break;
    case "left":
      registry.left(server, msg.room, msg.player);
      break;
    case "stats":
      registry.stats(server, msg.sample);
      break;
    case "migrating":
      registry.markMigrating(server, msg.room, msg.player);
      break;
  }
}

// ------------------------------------------------------------ cluster health

/** One aggregated sample per second over the live servers' latest samples. */
const clusterSamples: StatsSample[] = [];
function aggregate(now: number): StatsSample | null {
  const latest = registry
    .liveServers()
    .map((s) => s.samples.at(-1))
    .filter((s): s is StatsSample => s !== undefined && now - s.t < 2000);
  if (latest.length === 0) return null;
  const sum = (k: keyof StatsSample) => latest.reduce((a, s) => a + (s[k] as number), 0);
  const max = (k: keyof StatsSample) => Math.max(...latest.map((s) => s[k] as number));
  return {
    t: now,
    rooms: registry.roomCount(),
    players: sum("players"),
    sockets: sum("sockets"),
    cpu: sum("cpu"),
    loopP99Ms: max("loopP99Ms"),
    loopMaxMs: max("loopMaxMs"),
    ticks: sum("ticks"),
    tickP99Ms: max("tickP99Ms"),
    tickMaxMs: max("tickMaxMs"),
    rssMb: sum("rssMb"),
    heapMb: sum("heapMb"),
    egressMbps: sum("egressMbps"),
  };
}

function healthReport(since: number) {
  const views = new Map(registry.views().map((v) => [v.id, v]));
  return {
    status: "ok",
    runtime,
    now: Date.now(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    latest: clusterSamples.at(-1) ?? null,
    samples: clusterSamples.filter((s) => s.t > since),
    servers: registry.allServers().map((s) => ({
      server: s.server,
      alive: s.alive,
      capacity: s.capacity,
      players: views.get(s.server)?.players ?? 0,
      latest: s.samples.at(-1) ?? null,
    })),
  };
}

/** Ask hot servers to move some players of their busiest room elsewhere. */
function shedLoad(now: number): void {
  const live = registry.liveServers();
  if (live.length < 2) return; // nowhere to move to
  const views = new Map(registry.views().map((v) => [v.id, v]));
  for (const s of live) {
    const view = views.get(s.server)!;
    const recent = s.samples.slice(-HOT_SAMPLES);
    const slow = recent.length === HOT_SAMPLES && recent.every((x) => x.loopP99Ms > LOOP_P99_HOT_MS);
    const full = view.players / view.capacity > HARD_LIMIT;
    if (!slow && !full) continue;
    if (now - (lastOrder.get(s.server) ?? 0) < ORDER_COOLDOWN_MS) continue;
    const busiest = [...registry.roomsOn(s.server)]
      .map(([room, r]) => ({ room, here: r.perServer.get(s.server) ?? 0 }))
      .sort((a, b) => b.here - a.here)[0];
    if (!busiest) continue;
    const count = Math.min(busiest.here, Math.max(1, Math.ceil(view.players * SHED_RATIO)));
    lastOrder.set(s.server, now);
    console.log(`server ${s.server} is ${full ? "full" : "slow"}: moving ${count} players of room ${busiest.room}`);
    tell(s.server, { t: "move", room: busiest.room, count });
  }
}

setInterval(() => {
  const now = Date.now();
  for (const server of registry.sweep(now)) {
    console.warn(`server ${server} went silent; dropping its players`);
    broadcastPeers();
  }
  shedLoad(now);
  const sample = aggregate(now);
  if (sample) {
    clusterSamples.push(sample);
    if (clusterSamples.length > HISTORY) clusterSamples.shift();
  }
}, 1000);

// ------------------------------------------------------------ HTTP

async function handleJoin(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const room = await readJoinRequest(req, ROOM_ID_PATTERN);
  if (!room) return new Response("Invalid room", { status: 400 });
  const exp = Date.now() + TICKET_TTL_MS;
  // The seat is held a little longer than the ticket so a late connect still counts.
  const seat = registry.seat(room, { reservedUntil: exp + 5000, allowSpan: ALLOW_SPAN });
  if (!seat) return new Response("No game server available", { status: 503 });
  const ticket = sign({ kind: "player", room, server: seat.server.server, player: seat.player, exp }, SECRET);
  return Response.json({ serverId: seat.server.server, wsUrl: `${seat.server.publicUrl}?room=${room}&ticket=${ticket}`, ticket });
}

/**
 * A client its server asked to move presents its current (possibly expired)
 * ticket and gets one for another server, keeping its player id.
 */
async function handleMigrate(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const body = await readLimited(req, 4096);
  let token = "";
  try {
    token = (JSON.parse(body ?? "") as { ticket?: string }).ticket ?? "";
  } catch {
    // falls through to the 400 below
  }
  const current = verifyPlayer(token, SECRET, { allowExpired: true });
  if (!current) return new Response("Invalid ticket", { status: 400 });
  if (!registry.takeMigration(current.server, current.room, current.player)) {
    return new Response("Not asked to migrate", { status: 409 });
  }
  const exp = Date.now() + TICKET_TTL_MS;
  const seat = registry.seat(current.room, {
    reservedUntil: exp + 5000,
    allowSpan: true,
    exclude: new Set([current.server]),
    player: current.player,
  });
  if (!seat) return new Response("No other game server available", { status: 503 });
  const ticket = sign(
    { kind: "player", room: current.room, server: seat.server.server, player: current.player, exp, from: current.server },
    SECRET,
  );
  return Response.json({
    serverId: seat.server.server,
    wsUrl: `${seat.server.publicUrl}?room=${current.room}&ticket=${ticket}`,
    ticket,
  });
}

async function handleHttp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    switch (url.pathname) {
      case "/healthz":
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      case "/api/health": {
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        return rejectWithoutHealthToken(req, url) ?? Response.json(healthReport(since), { headers: { "cache-control": "no-store" } });
      }
      case "/api/join":
        return await handleJoin(req);
      case "/api/migrate":
        return await handleMigrate(req);
      case "/api/rooms":
        return createRoom(req, SECRET);
      default:
        return await serveStatic(req);
    }
  } catch (err) {
    console.error(err);
    return new Response(null, { status: 500 });
  }
}

Bun.serve<LinkData>({
  port: PORT,
  hostname: HOST,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname !== "/internal") return handleHttp(req);
    // Only game servers holding a token signed with CLUSTER_SECRET may connect here.
    const token = verifyServer(url.searchParams.get("token") ?? "", SECRET);
    if (!token || !server.upgrade(req, { data: { server: token.server } })) {
      return new Response("Unauthorized", { status: 401 });
    }
    return undefined;
  },
  websocket: {
    idleTimeout: 30,
    sendPings: true,
    open(ws) {
      links.get(ws.data.server)?.close(); // a reconnect replaces the old link
      links.set(ws.data.server, ws);
    },
    message(ws, message) {
      if (typeof message === "string") onLinkMessage(ws.data.server, JSON.parse(message) as ServerToAgent);
    },
    close(ws) {
      if (links.get(ws.data.server) !== ws) return;
      links.delete(ws.data.server);
      registry.serverLost(ws.data.server);
      console.warn(`server ${ws.data.server} disconnected`);
      broadcastPeers();
    },
  },
});

console.log(`daystar agent on http://${HOST}:${PORT} (${runtime})`);
warnIfClientMissing(CLIENT_DIR);
