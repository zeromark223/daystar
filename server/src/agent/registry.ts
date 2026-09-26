import type { StatsSample } from "../stats.ts";
import type { ServerInfo } from "../cluster/control.ts";
import { overloaded, place, type RoomView, type ServerView } from "./placement.ts";

/** A freed player id is not handed out again before this, so late packets cannot collide. */
const ID_REUSE_DELAY_MS = 60_000;
/** Stats older than this mean the server is gone. */
const STATS_TIMEOUT_MS = 3_000;
const HISTORY = 300;

interface Seat {
  server: number;
  /** Unix ms until which an unused ticket keeps the seat; null once connected. */
  reservedUntil: number | null;
}

interface RoomState {
  home: number | null;
  seats: Map<number, Seat>;
  /** Freed ids and when they may be reused. */
  cooling: Map<number, number>;
  nextId: number;
}

interface ServerState extends ServerInfo {
  alive: boolean;
  lastSeen: number;
  samples: StatsSample[];
}

/**
 * The agent's view of the cluster: live servers, which players sit where, and
 * player id allocation. Everything the placement function needs.
 */
export class Registry {
  private readonly servers = new Map<number, ServerState>();
  private readonly rooms = new Map<string, RoomState>();

  // ------------------------------------------------------------ servers

  register(info: ServerInfo, players: { room: string; player: number }[], now = Date.now()): void {
    this.dropSeatsOf(info.server, now);
    this.servers.set(info.server, { ...info, alive: true, lastSeen: now, samples: this.servers.get(info.server)?.samples ?? [] });
    for (const { room, player } of players) {
      const r = this.room(room);
      r.home ??= info.server;
      r.seats.set(player, { server: info.server, reservedUntil: null });
    }
  }

  /** The server's link closed or went silent: forget its players and stop placing there. */
  serverLost(server: number, now = Date.now()): void {
    const s = this.servers.get(server);
    if (!s) return;
    s.alive = false;
    this.dropSeatsOf(server, now);
  }

  stats(server: number, sample: StatsSample, now = Date.now()): void {
    const s = this.servers.get(server);
    if (!s) return;
    s.lastSeen = now;
    s.samples.push(sample);
    if (s.samples.length > HISTORY) s.samples.shift();
  }

  /** Mark servers dead after STATS_TIMEOUT_MS of silence and expire unused tickets. */
  sweep(now = Date.now()): number[] {
    const lost: number[] = [];
    for (const s of this.servers.values()) {
      if (s.alive && now - s.lastSeen > STATS_TIMEOUT_MS) {
        this.serverLost(s.server, now);
        lost.push(s.server);
      }
    }
    for (const [name, r] of this.rooms) {
      for (const [id, seat] of r.seats) {
        if (seat.reservedUntil !== null && seat.reservedUntil < now) this.free(r, id, now);
      }
      for (const [id, at] of r.cooling) if (at <= now) r.cooling.delete(id);
      if (r.seats.size === 0 && r.cooling.size === 0) this.rooms.delete(name);
    }
    return lost;
  }

  liveServers(): ServerState[] {
    return [...this.servers.values()].filter((s) => s.alive);
  }

  server(id: number): ServerState | undefined {
    const s = this.servers.get(id);
    return s?.alive ? s : undefined;
  }

  allServers(): ServerState[] {
    return [...this.servers.values()];
  }

  // ------------------------------------------------------------ players

  /**
   * Choose a server for a player of `room` and hold a seat until `reservedUntil`
   * (the ticket's expiry). Keeps `player` when given (migration), else allocates.
   */
  seat(
    room: string,
    opts: { reservedUntil: number; allowSpan: boolean; exclude?: ReadonlySet<number>; player?: number },
    now = Date.now(),
  ): { server: ServerState; player: number } | null {
    const r = this.rooms.get(room);
    const serverId = place(this.views(), r && this.roomView(r), { allowSpan: opts.allowSpan, exclude: opts.exclude });
    if (serverId === null) return null;
    const target = this.room(room);
    const player = opts.player ?? this.allocate(target, now);
    if (player === null) return null;
    target.home ??= serverId;
    target.seats.set(player, { server: serverId, reservedUntil: opts.reservedUntil });
    return { server: this.servers.get(serverId)!, player };
  }

  /** The server confirmed the player connected with its ticket. */
  joined(server: number, room: string, player: number): void {
    const r = this.room(room);
    r.home ??= server;
    r.seats.set(player, { server, reservedUntil: null });
  }

  /** The player left the cluster (not a migration). */
  left(server: number, room: string, player: number, now = Date.now()): void {
    const r = this.rooms.get(room);
    const seat = r?.seats.get(player);
    // A migrated player's seat already points at the new server; ignore the old one.
    if (r && seat && seat.server === server) this.free(r, player, now);
  }

  /** Server currently holding the player's seat, if any. */
  seatOf(room: string, player: number): number | undefined {
    return this.rooms.get(room)?.seats.get(player)?.server;
  }

  // ------------------------------------------------------------ views

  views(): ServerView[] {
    const counts = new Map<number, number>();
    for (const r of this.rooms.values()) for (const seat of r.seats.values()) counts.set(seat.server, (counts.get(seat.server) ?? 0) + 1);
    return [...this.servers.values()].map((s) => ({ id: s.server, alive: s.alive, capacity: s.capacity, players: counts.get(s.server) ?? 0 }));
  }

  overloaded(): ServerView[] {
    return overloaded(this.views());
  }

  /** Players per server of each room hosted by `server`. */
  roomsOn(server: number): Map<string, RoomView> {
    const out = new Map<string, RoomView>();
    for (const [name, r] of this.rooms) {
      const view = this.roomView(r);
      if (view.perServer.has(server)) out.set(name, view);
    }
    return out;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  // ------------------------------------------------------------ internals

  private room(name: string): RoomState {
    let r = this.rooms.get(name);
    if (!r) {
      r = { home: null, seats: new Map(), cooling: new Map(), nextId: 1 };
      this.rooms.set(name, r);
    }
    return r;
  }

  private roomView(r: RoomState): RoomView {
    const perServer = new Map<number, number>();
    for (const seat of r.seats.values()) perServer.set(seat.server, (perServer.get(seat.server) ?? 0) + 1);
    const home = r.home !== null && this.servers.get(r.home)?.alive ? r.home : null;
    return { home, perServer };
  }

  /**
   * Room-scoped u16 id. Future (docs/cluster.md): a global id scheme so the agent
   * is not on the id path.
   */
  private allocate(r: RoomState, now: number): number | null {
    for (let i = 0; i < 0xffff; i++) {
      const id = r.nextId;
      r.nextId = r.nextId >= 0xffff ? 1 : r.nextId + 1;
      const coolUntil = r.cooling.get(id);
      if (r.seats.has(id) || (coolUntil !== undefined && coolUntil > now)) continue;
      r.cooling.delete(id);
      return id;
    }
    return null;
  }

  private free(r: RoomState, id: number, now: number): void {
    r.seats.delete(id);
    r.cooling.set(id, now + ID_REUSE_DELAY_MS);
  }

  private dropSeatsOf(server: number, now: number): void {
    for (const r of this.rooms.values()) {
      for (const [id, seat] of r.seats) if (seat.server === server) this.free(r, id, now);
      if (r.home === server) r.home = null;
    }
  }
}
