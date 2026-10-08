/**
 * How smooth do other players look? One observer stands still while a few walkers
 * pace back and forth in front of it. The observer replays how a client draws them
 * on a simulated 60 Hz display, and measures how far each walker moves per frame.
 * A walker at constant speed should move the same distance every frame; frames
 * that move much less or more are the "small hitches" (or stalls) one sees.
 *
 * Three ways of drawing are compared on the same data:
 * - old: positions stamped with their arrival time, drawn two intervals back;
 * - new: what the client does now (client/src/game/timeline.ts), on the server's
 *   timeline from the snapshot's time and each entry's age;
 * - ideal: stamped with the walker's own send time (only possible in this probe).
 *
 * Walkers come in two kinds: "raf" sends like the browser (a move on the first
 * display frame at least 50 ms after the last one), "timer" like the load-test bots
 * (a setInterval every 50 ms). --jitter delays what the observer receives by up to
 * that many ms, like a phone network. Run it next to a load test for a busy room:
 *
 *   bun tools/loadtest.ts --max 100 --hold 600 --moving 0.2 --chat-every 0 --room-prefix smooth
 *   bun tools/smoothness.ts --target http://127.0.0.1:3300 --room smooth-all --jitter 80
 */
import { parseArgs } from "node:util";
import { MOVE_SPEED, TICK_RATE } from "../shared/src/constants.ts";
import type { Direction } from "../shared/src/direction.ts";
import { decodeServerMessage, encodeClientMessage, quantize, type ServerMessage } from "../shared/src/protocol.ts";
import { canBeAt } from "../shared/src/space.ts";
import { PlayoutClock, Track } from "../client/src/game/timeline.ts";

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "http://127.0.0.1:3300" },
    room: { type: "string", default: "smooth-all" },
    walkers: { type: "string", default: "3" },
    seconds: { type: "string", default: "60" },
    fps: { type: "string", default: "60" },
    /** Extra delay (0..ms, random, order kept) on everything the observer receives, like a phone network. */
    jitter: { type: "string", default: "0" },
  },
});
const BASE = values.target!.replace(/\/$/, "");
const SECONDS = Number(values.seconds);
const FRAME_MS = 1000 / Number(values.fps);
const SEND_INTERVAL_MS = 1000 / TICK_RATE;
/** Each leg of a walker's pacing, and the time around a turn left out of the stats. */
const LEG_MS = 2000;
const TURN_MARGIN_MS = 500;

type Kind = "raf" | "timer";
interface Walker {
  kind: Kind;
  id: number;
  ws: WebSocket;
  x: number;
  y: number;
  dirSign: 1 | -1;
  /** Where it paces from (beside the observer, to stay in its view), and when it got there. */
  home: { x: number; y: number };
  arrivedAt: number | null;
  /** performance.now() of every turn, to skip frames drawn around it. */
  turns: number[];
  /** Wire position -> when it was sent, to replay with sender time stamps. */
  sentAt: Map<string, number>;
}

/** The web client's remote-player buffer (avatar.ts), for one walker. */
class Replay {
  samples: { t: number; x: number; y: number }[] = [];
  last: { x: number; y: number } | null = null;
  ratios: number[] = [];
  push(t: number, x: number, y: number, intervalMs: number): void {
    const last = this.samples.at(-1);
    if (last && t - last.t > 3 * intervalMs) this.samples.push({ ...last, t: t - intervalMs });
    this.samples.push({ t, x, y });
    if (this.samples.length > 30) this.samples.shift();
  }
  at(renderT: number): { x: number; y: number } | null {
    const s = this.samples;
    while (s.length >= 2 && s[1].t <= renderT) s.shift();
    const [a, b] = s;
    if (!a) return null;
    if (!b || renderT <= a.t) return { x: a.x, y: a.y };
    const k = (renderT - a.t) / (b.t - a.t);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }
}

async function open(name: string): Promise<{ ws: WebSocket; welcome: Extract<ServerMessage, { t: "welcome" }> }> {
  const res = await fetch(`${BASE}/api/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room: values.room }),
  });
  const { wsUrl } = (await res.json()) as { wsUrl: string };
  const base = new URL(BASE);
  const url = wsUrl.startsWith("/") ? `${base.protocol === "https:" ? "wss:" : "ws:"}//${base.host}${wsUrl}` : wsUrl;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => ws.send(encodeClientMessage({ t: "join", name, appearance: 0, hostKey: "" })));
    ws.addEventListener("error", reject);
    const onWelcome = (e: MessageEvent) => {
      const msg = decodeServerMessage(new Uint8Array(e.data as ArrayBuffer));
      if (msg?.t !== "welcome") return;
      ws.removeEventListener("message", onWelcome);
      resolve({ ws, welcome: msg });
    };
    ws.addEventListener("message", onWelcome);
  });
}

const key = (x: number, y: number) => `${quantize(x)},${quantize(y)}`;

function send(w: Walker, now: number): void {
  const dir: Direction = w.dirSign > 0 ? "east" : "west";
  w.ws.send(encodeClientMessage({ t: "move", x: w.x, y: w.y, dir, moving: true }));
  w.sentAt.set(key(w.x, w.y), now);
  if (w.sentAt.size > 400) w.sentAt.delete(w.sentAt.keys().next().value!);
}

/** Advance a walker by `dt` ms along its leg, turning at the end of each leg. */
function step(w: Walker, dt: number, now: number): void {
  const reach = MOVE_SPEED * (dt / 1000);
  if (w.arrivedAt === null) {
    // First walk up to the observer: players out of its view are not sent to it.
    const dx = w.home.x - w.x;
    const dy = w.home.y - w.y;
    const len = Math.hypot(dx, dy);
    const k = len <= reach ? 1 : reach / len;
    const nx = quantize(w.x + dx * k);
    const ny = quantize(w.y + dy * k);
    if (canBeAt(nx, ny)) {
      w.x = nx;
      w.y = ny;
    }
    if (len <= reach) {
      w.arrivedAt = now;
      w.turns.push(now);
    }
    return;
  }
  if (now - (w.turns.at(-1) ?? 0) >= LEG_MS) {
    w.dirSign = w.dirSign > 0 ? -1 : 1;
    w.turns.push(now);
  }
  const nx = quantize(w.x + w.dirSign * reach);
  if (canBeAt(nx, w.y)) w.x = nx;
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? NaN;
}

async function main(): Promise<void> {
  const observer = await open("Observer");
  const selfId = observer.welcome.selfId;
  let intervalMs = 1000 / observer.welcome.snapshotHz;
  const me = observer.welcome.players.find((p) => p.id === selfId)!;

  const count = Number(values.walkers);
  const walkers: Walker[] = [];
  const corrections = new Map<Kind, number>();
  for (let i = 0; i < count * 2; i++) {
    const kind: Kind = i < count ? "raf" : "timer";
    const { ws, welcome } = await open(`${kind}-${i}`);
    const self = welcome.players.find((p) => p.id === welcome.selfId)!;
    const home = { x: me.x - 400, y: me.y - 150 + i * 50 };
    const w: Walker = { kind, id: welcome.selfId, ws, x: self.x, y: self.y, home, arrivedAt: null, dirSign: 1, turns: [], sentAt: new Map() };
    ws.addEventListener("message", (e) => {
      const msg = decodeServerMessage(new Uint8Array(e.data as ArrayBuffer));
      if (msg?.t === "correction") {
        corrections.set(kind, (corrections.get(kind) ?? 0) + 1);
        w.x = msg.x;
        w.y = msg.y;
      }
    });
    walkers.push(w);
  }
  const byId = new Map(walkers.map((w) => [w.id, w]));
  const arrival = new Map(walkers.map((w) => [w.id, new Replay()]));
  // The client today: server time stamps, PlayoutClock and Track (client/src/game/timeline.ts).
  const clock = new PlayoutClock();
  const tracks = new Map(walkers.map((w) => [w.id, new Track()]));
  const sender = new Map(walkers.map((w) => [w.id, new Replay()]));
  const gaps: number[] = [];
  const lastArrival = new Map<number, number>();
  const latency: number[] = [];

  const jitterMs = Number(values.jitter);
  let deliverAt = 0;
  const receive = (data: ArrayBuffer) => {
    const now = performance.now();
    const msg = decodeServerMessage(new Uint8Array(data));
    if (msg?.t === "rate") {
      intervalMs = 1000 / msg.snapshotHz;
      clock.intervalMs = intervalMs;
      Track.idleGapMs = 3 * intervalMs;
    }
    if (msg?.t !== "snapshot" && msg?.t !== "view") return;
    const serverTime = msg.t === "snapshot" ? clock.observe(msg.time, now) : clock.latest;
    for (const p of msg.players) {
      const age = "age" in p ? (p.age as number) : 0;
      tracks.get(p.id)?.push({ t: serverTime - age, x: p.x, y: p.y, dir: p.dir, moving: p.moving });
      const w = byId.get(p.id);
      if (!w) continue;
      const prev = lastArrival.get(p.id);
      if (prev !== undefined && w.arrivedAt !== null && now > w.arrivedAt + 1000) gaps.push(now - prev);
      lastArrival.set(p.id, now);
      arrival.get(p.id)!.push(now, p.x, p.y, intervalMs);
      const sentT = w.sentAt.get(key(p.x, p.y));
      if (sentT !== undefined) {
        latency.push(now - sentT);
        sender.get(p.id)!.push(sentT, p.x, p.y, intervalMs);
      }
    }
  };
  observer.ws.addEventListener("message", (e) => {
    const data = e.data as ArrayBuffer;
    if (jitterMs <= 0) return receive(data);
    // A slow network delays frames by varying amounts but keeps their order.
    deliverAt = Math.max(deliverAt, performance.now() + Math.random() * jitterMs);
    setTimeout(() => receive(data), deliverAt - performance.now());
  });

  console.log(
    `Observer ${selfId} at (${Math.round(me.x)}, ${Math.round(me.y)}); ${count} raf + ${count} timer walkers; ${values.fps} fps; ${SECONDS} s`,
  );

  // The walkers' clocks: "raf" on display frames (with ±0.5 ms vsync jitter), "timer" every 50 ms.
  const start = performance.now();
  const lastSent = new Map<number, number>();
  let frame = 0;
  const rafWalk = setInterval(() => {
    const now = performance.now();
    while (start + (frame + 1) * FRAME_MS <= now) {
      frame++;
      const t = start + frame * FRAME_MS + (Math.random() - 0.5);
      for (const w of walkers) {
        if (w.kind !== "raf") continue;
        step(w, FRAME_MS, t);
        if (t - (lastSent.get(w.id) ?? 0) >= SEND_INTERVAL_MS) {
          send(w, t);
          lastSent.set(w.id, t);
        }
      }
    }
  }, 2);
  const timerWalk = setInterval(() => {
    const now = performance.now();
    for (const w of walkers) {
      if (w.kind !== "timer") continue;
      step(w, now - (lastSent.get(w.id) ?? now - SEND_INTERVAL_MS), now);
      send(w, now);
      lastSent.set(w.id, now);
    }
  }, SEND_INTERVAL_MS);

  // The observer's display: draw every walker each frame, as the client would.
  const lastDrawn = new Map<string, { x: number; y: number }>();
  const ratios = { arrival: new Map<Kind, number[]>(), server: new Map<Kind, number[]>(), sender: new Map<Kind, number[]>() };
  let drawFrame = 0;
  const senderDelay = () => intervalMs * 2 + 50;
  const draw = setInterval(() => {
    const now = performance.now();
    while (start + (drawFrame + 1) * FRAME_MS <= now) {
      drawFrame++;
      const t = start + drawFrame * FRAME_MS;
      const serverRender = clock.renderTime(t);
      for (const w of walkers) {
        const track = tracks.get(w.id)!;
        for (const [mode, at, renderT] of [
          ["arrival", (rt: number) => arrival.get(w.id)!.at(rt), t - 2 * intervalMs],
          // Server timeline; the local moment it shows is about `delayMs` (+ the network) ago.
          ["server", () => track.at(serverRender), t - clock.delayMs - 15],
          ["sender", (rt: number) => sender.get(w.id)!.at(rt), t - senderDelay()],
        ] as const) {
          const pos = at(renderT);
          const k = `${mode}:${w.id}`;
          const prev = lastDrawn.get(k);
          if (pos) lastDrawn.set(k, pos);
          if (!pos || !prev) continue;
          // Skip frames whose drawn moment is near a turn (and allow for latency).
          const drawnAt = renderT - (mode === "arrival" ? 30 : 0);
          if (w.arrivedAt === null || drawnAt < w.arrivedAt + 1000) continue;
          if (w.turns.some((tt) => Math.abs(drawnAt - tt) < TURN_MARGIN_MS)) continue;
          const moved = Math.hypot(pos.x - prev.x, pos.y - prev.y);
          const list = ratios[mode].get(w.kind) ?? [];
          list.push(moved / (MOVE_SPEED * (FRAME_MS / 1000)));
          ratios[mode].set(w.kind, list);
        }
      }
    }
  }, 2);

  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(rafWalk);
  clearInterval(timerWalk);
  clearInterval(draw);

  const fmt = (v: number) => v.toFixed(2);
  console.log(`corrections: raf ${corrections.get("raf") ?? 0}, timer ${corrections.get("timer") ?? 0}`);
  console.log(`snapshot interval ${intervalMs.toFixed(0)} ms`);
  const g = gaps.sort((a, b) => a - b);
  console.log(`walker sample gaps at the observer: p50 ${pct(g, 0.5).toFixed(1)} p99 ${pct(g, 0.99).toFixed(1)} max ${g.at(-1)?.toFixed(1)} ms`);
  const l = latency.sort((a, b) => a - b);
  console.log(`send -> seen: p50 ${pct(l, 0.5).toFixed(1)} p99 ${pct(l, 0.99).toFixed(1)} ms`);
  console.log("per-frame movement / expected (1.00 = perfectly even); hitch = outside 0.75..1.33, stall = < 0.05");
  for (const mode of ["arrival", "server", "sender"] as const) {
    for (const kind of ["raf", "timer"] as const) {
      const r = (ratios[mode].get(kind) ?? []).sort((a, b) => a - b);
      if (r.length === 0) continue;
      const hitch = r.filter((v) => v < 0.75 || v > 1.33).length;
      const stall = r.filter((v) => v < 0.05).length;
      const label = { arrival: "old (arrival time)", server: "new (server time)", sender: "ideal (sender time)" }[mode];
      console.log(
        `  ${label.padEnd(26)} ${kind.padEnd(5)} frames ${String(r.length).padStart(6)}  p1 ${fmt(pct(r, 0.01))} p5 ${fmt(pct(r, 0.05))} p50 ${fmt(pct(r, 0.5))} p95 ${fmt(pct(r, 0.95))} p99 ${fmt(pct(r, 0.99))}  hitch ${((hitch / r.length) * 100).toFixed(1)}%  stall ${((stall / r.length) * 100).toFixed(2)}%  (${((hitch / r.length) * Number(values.fps) * 60).toFixed(0)}/min)`,
      );
    }
  }
  observer.ws.close();
  for (const w of walkers) w.ws.close();
  process.exit(0);
}

void main();
