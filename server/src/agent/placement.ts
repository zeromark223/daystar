/**
 * Where a player should connect. Pure function of the agent's view so it can be
 * tested on its own; see docs/cluster.md "Placement".
 */

export const SOFT_LIMIT = 0.7;
export const HARD_LIMIT = 0.9;

export interface ServerView {
  id: number;
  alive: boolean;
  capacity: number;
  /** Players connected or holding an unexpired ticket. */
  players: number;
}

export interface RoomView {
  /** Server that first hosted the room; null when that server is gone. */
  home: number | null;
  /** Players (connected or reserved) per server hosting part of the room. */
  perServer: ReadonlyMap<number, number>;
}

export interface PlaceOptions {
  /** Servers not to use, e.g. the one a migrating player is leaving. */
  exclude?: ReadonlySet<number>;
  /**
   * Whether a room may span several servers. Without it every player of a room
   * goes to the room's server (room affinity only).
   */
  allowSpan: boolean;
}

const load = (s: ServerView) => s.players / s.capacity;

/** Least-loaded server first; ties by id so the result is deterministic. */
function byLoad(a: ServerView, b: ServerView): number {
  return load(a) - load(b) || a.id - b.id;
}

/** Returns the server id to use, or null when no server is available. */
export function place(servers: readonly ServerView[], room: RoomView | undefined, opts: PlaceOptions): number | null {
  const usable = servers.filter((s) => s.alive && s.capacity > 0 && !opts.exclude?.has(s.id)).sort(byLoad);
  if (usable.length === 0) return null;
  const byId = new Map(usable.map((s) => [s.id, s]));
  const underSoft = (s: ServerView | undefined) => s !== undefined && load(s) < SOFT_LIMIT;

  // Rooms already hosted somewhere: keep them together when possible.
  const hosts = room ? [...room.perServer.keys()].filter((id) => byId.has(id)) : [];
  if (room && hosts.length > 0) {
    const home = room.home !== null ? byId.get(room.home) : undefined;
    if (!opts.allowSpan) {
      // Affinity only: the room stays on its home, or on whichever host still lives.
      return (home ?? hosts.map((id) => byId.get(id)!).sort(byLoad)[0]).id;
    }
    if (underSoft(home)) return home!.id;
    const other = hosts
      .map((id) => byId.get(id)!)
      .filter((s) => s.id !== home?.id && underSoft(s))
      .sort(byLoad)[0];
    if (other) return other.id;
  }
  // New room, or every host is busy: the least-loaded server (the room may now span).
  return usable[0].id;
}

/** Servers that should shed players: above the hard limit. */
export function overloaded(servers: readonly ServerView[]): ServerView[] {
  return servers.filter((s) => s.alive && s.capacity > 0 && load(s) > HARD_LIMIT);
}
