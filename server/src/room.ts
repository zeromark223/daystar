import { isAppearanceId, type AppearanceId } from "../../shared/src/appearance.ts";
import {
  CHAT_HISTORY_SIZE,
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SPEAKERS,
  MAX_VOICE_FRAME_BYTES,
  MOVE_SPEED,
  OVERCHARGE_FORCE_AT,
  SNAPSHOT_GROUPS_AT,
  SNAPSHOT_GROUPS_OFF_BELOW,
  TICK_RATE,
  VOICE_BYTES_PER_SEC,
  VOICE_FLUSH_MS,
  WORLD_CENTER,
} from "../../shared/src/constants.ts";
import type { Direction } from "../../shared/src/direction.ts";
import { cellFullyInView, cellOf, cellSetInView, cellsInView, inView } from "../../shared/src/aoi.ts";
import { canSpeak, type Role } from "../../shared/src/roles.ts";
import { canBeAt, spawnPoint } from "../../shared/src/space.ts";
import { recordEgress, recordTick } from "./stats.ts";
import {
  handTicket,
  MAX_REACTIONS_PER_SNAPSHOT,
  REACTION_BURST,
  REACTIONS_PER_SEC,
  type Reaction,
} from "../../shared/src/audience.ts";
import { cleanPoll, POLL_COUNT_MS, pollZoneAt, type Poll } from "../../shared/src/poll.ts";
import { freeSlot, NO_SLOT, orbitPosition, STAGE_SLOTS } from "../../shared/src/orbit.ts";
import {
  assembleSnapshot,
  decodeClientMessage,
  encodeServerMessage,
  snapshotEntry,
  snapshotTail,
  quantize,
  type ChatMessage,
  type OrbitState,
  type SlotChange,
  type PlayerInfo,
  type PlayerState,
  type ServerMessage,
  type VoiceFrame,
} from "../../shared/src/protocol.ts";

/** Extra distance tolerated per move to absorb network jitter. */
const MOVE_SLACK = 24;
const CHAT_BURST = 5;
const CHAT_WINDOW_MS = 5000;
/** A player asked to migrate is not asked again for this long (and stays if it never moves). */
const MIGRATE_RETRY_MS = 30_000;
/** A player may ask "who" this often. */
const WHO_MIN_MS = 250;
/** Voice frames held for one tick at most (a tick normally carries 2-3 per speaker). */
const MAX_PENDING_VOICE = 200;

/** A connected client, whatever the runtime's WebSocket implementation is. */
export interface Peer {
  send(data: Uint8Array): void;
  close(): void;
  /**
   * Join / leave one of the room's broadcast channels: ROOM_CHANNEL (events for
   * everyone) and the snapshot channel of the player's map cell and group. Only
   * needed when the room has a `publish` function (Bun topics).
   */
  subscribe?(channel: string): void;
  unsubscribe?(channel: string): void;
}

/** Channel for events every player gets (joins, chat, roles...). */
export const ROOM_CHANNEL = "";
/** Snapshots for the viewers in one map cell (area of interest) and snapshot group. */
export const viewChannel = (cell: number, group: number) => `v${cell}:${group}`;

/**
 * Sends one frame to every peer subscribed to one of the room's channels in a
 * single call (Bun's server.publish fans out natively). Without it the room loops over peers.
 */
export type Publish = (channel: string, data: Uint8Array) => void;

/** Changes, voice, joins and leaves a snapshot group has not been sent yet. */
interface Pending {
  changed: Set<Player>;
  voice: VoiceFrame[];
  /** When the oldest frame in `voice` arrived (Date.now()). */
  voiceSince: number;
  /** Players who joined (described as they are at flush time) and ids that left. */
  joined: Set<number>;
  left: number[];
  /** Reactions (capped at MAX_REACTIONS_PER_SNAPSHOT), hands by player id, new poll counts. */
  reactions: Reaction[];
  hands: Map<number, number>;
  pollCounts: number[] | null;
  /** Orbit mode: seats given since the last snapshot. */
  slots: Map<number, number>;
}

/** Orbit mode between servers: started (with every seat), or released at `at` (Unix ms). */
export type OrbitSync = { active: true; start: number; slots: SlotChange[] } | { active: false; at: number };

/** Events the runtime adapter forwards to the room for one peer. */
export interface PeerEvents {
  message(data: Uint8Array): void;
  close(): void;
}

/**
 * Cluster: where the room sends what happens to its *local* players so servers
 * hosting the same room can mirror them (docs/cluster.md "Mesh sync").
 */
export interface RoomSync {
  joined(player: PlayerInfo): void;
  left(id: number): void;
  /** Local players that changed during one tick. */
  moves(players: PlayerState[]): void;
  chat(message: ChatMessage): void;
  /** A local player's role changed. */
  role(id: number, role: Role): void;
  /** Ask server `owner` to change the role of its player `id` (the host is elsewhere). */
  setRole(owner: number, id: number, role: Role): void;
  /** Voice frames from local speakers during one tick. */
  voice(frames: VoiceFrame[]): void;
  /** Reactions from local players during one tick. */
  reactions(list: Reaction[]): void;
  /** A local player's hand went up (its ticket) or down (0). */
  hand(id: number, hand: number): void;
  /** Ask server `owner` to change the hand of its player `id` (the host lowered it). */
  setHand(owner: number, id: number, hand: number): void;
  /** Our host started or ended a poll. */
  poll(poll: Poll): void;
  /** Our host gathered everyone, or let them go. */
  orbit(orbit: OrbitSync): void;
  /** Seats we gave our players during an orbit (NO_SLOT: none any more). */
  slots(list: SlotChange[]): void;
}

interface Player {
  id: number;
  /** null: this server holds the player's socket and is authoritative. Else the owning server. */
  owner: number | null;
  /** The socket, for local players only. */
  peer: Peer | null;
  /** Snapshot group (0 or 1), for local players only. */
  group: number;
  /** Map cell the player views from (area of interest), for local players only. */
  cell: number;
  /** Map cell the player is filed under in the room's grid (every player). */
  gridCell: number;
  name: string;
  appearance: AppearanceId;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
  role: Role;
  /** Raised hand ticket (see handTicket), or 0. */
  hand: number;
  lastMoveAt: number;
  /** When this server last got the player's state (a move, here or from its server); snapshots carry its age. */
  movedAt: number;
  chatTimes: number[];
  /** When the player last asked "who" (rate limit). */
  whoAt: number;
  /** Reaction rate limit: tokens refilled at REACTIONS_PER_SEC. */
  reactBudget: number;
  reactAt: number;
  /** Voice rate limit: a byte budget refilled at VOICE_BYTES_PER_SEC. */
  voiceBudget: number;
  voiceAt: number;
}

export interface RoomOptions {
  /** Called when the last connection closes; the owner drops the room. */
  onEmpty(): void;
  /** Native fan-out (Bun topic); without it broadcasts loop over peers. */
  publish?: Publish | null;
  /** Cluster: report local players to the agent. */
  onJoined?(player: number): void;
  onLeft?(player: number): void;
  /** Cluster: mirror local players to other servers hosting this room. */
  sync?: RoomSync;
  /** Cluster: chat ids are `chatIdBase | counter` (serverId << 24) so servers never collide. */
  chatIdBase?: number;
  /**
   * Standalone keeps the last messages for newcomers. Cluster mode keeps none
   * (future: chat history in a separate database service, docs/cluster.md).
   */
  keepChatHistory?: boolean;
  /** Whether a key presented on join is this room's host key. Without it nobody can be host. */
  isHostKey?(key: string): boolean;
  /**
   * A fixed schedule instead of the automatic one (A/B tests): the room ticks
   * `tickHz` times a second and serves `groups` groups in turn, so each player
   * gets tickHz / groups snapshots per second.
   */
  schedule?: { tickHz: number; groups: 1 | 2 };
  /** Snapshots per second per player the server's overcharge allows (default TICK_RATE). */
  rate?: number;
}

export class Room {
  readonly id: string;
  /** Local players and replicas of players connected to other servers. */
  private readonly players = new Map<number, Player>();
  private localCount = 0;
  private readonly chat: ChatMessage[] = [];
  /** Open sockets, including ones that have not joined yet. */
  private connections = 0;
  private nextPlayerId = 1;
  private nextChatId = 1;
  /**
   * Snapshot groups in use: 1 (everyone every tick) or 2 (alternate ticks).
   * Local players always belong to group 0 or 1, so switching needs no resubscribing.
   */
  private groups: number;
  /** Room ticks per second; each group gets tickHz / groups snapshots per second. */
  private tickHz: number;
  /** Snapshots per second per player allowed by the overcharge. */
  private rate: number;
  private readonly groupSizes = [0, 0];
  private ticks = 0;
  /** Per group: players (local or replicated) changed and voice received since its last snapshot. */
  private readonly pending: Pending[] = [newPending(), newPending()];
  /** The groups' pending sets differ (after a 2-group tick); they are flushed separately. */
  private diverged = false;
  /** Players changed during the current tick, and local voice frames, for the mesh. */
  private readonly tickChanged = new Set<Player>();
  /** Local players by the map cell they view from: one snapshot per cell and group. */
  private readonly viewers = new Map<number, Set<Player>>();
  /** Every player (local or replica) by map cell, to find who is in view. */
  private readonly grid = new Map<number, Set<Player>>();
  private localVoice: VoiceFrame[] = [];
  private localReactions: Reaction[] = [];
  /** The open poll, if any; counts are recounted every POLL_COUNT_MS. */
  private poll: Poll | null = null;
  private pollCountedAt = 0;
  /**
   * Players who moved since the poll started. Only they vote: newcomers can
   * spawn inside an answer planet, and that is not a choice.
   */
  private readonly pollMovers = new Set<number>();
  /** Orbit mode: when it started (Unix ms) and everyone's seat. Nobody moves meanwhile. */
  private orbit: { start: number; slots: Map<number, number> } | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Local players asked to migrate, and when they may be asked again. */
  private readonly migrating = new Map<number, number>();
  private readonly publish: Publish | null;
  private readonly opts: RoomOptions;

  constructor(id: string, opts: RoomOptions) {
    this.id = id;
    this.publish = opts.publish ?? null;
    this.opts = opts;
    this.rate = opts.rate ?? TICK_RATE;
    this.tickHz = opts.schedule?.tickHz ?? this.rate;
    this.groups = opts.schedule?.groups ?? 1;
  }

  /** The overcharge changed the snapshot rate players may get. */
  setRate(rate: number): void {
    this.rate = rate;
    this.applySchedule(this.localCount);
  }

  /** Players connected to this server (replicas excluded). */
  get playerCount(): number {
    return this.localCount;
  }

  /** Snapshots per second each player receives. */
  get snapshotHz(): number {
    return this.tickHz / this.groups;
  }

  /** Ids of players connected to this server. */
  playerIds(): number[] {
    return [...this.players.values()].filter((p) => p.owner === null).map((p) => p.id);
  }

  /** The orbit, for a peer that starts mirroring this room. */
  currentOrbit(): OrbitSync | null {
    return this.orbit ? { active: true, start: this.orbit.start, slots: slotList(this.orbit.slots) } : null;
  }

  /** The open poll, for a peer that starts mirroring this room. */
  currentPoll(): Poll | null {
    return this.poll;
  }

  /** Full state of the local players, for a peer that starts mirroring this room. */
  localState(): PlayerInfo[] {
    return [...this.players.values()].filter((p) => p.owner === null).map(toInfo);
  }

  /**
   * Add a freshly upgraded connection; it becomes a player once it sends "join".
   * `playerId` is the id from the agent's ticket in cluster mode. `resume`, for a
   * migrating player, resolves to its state on the previous server (or null).
   * The runtime adapter must call the returned handlers for binary messages and on close.
   */
  accept(peer: Peer, playerId?: number, resume?: Promise<PlayerInfo | null>): PeerEvents {
    let player: Player | null = null;
    let joining = false;
    this.connections++;

    return {
      message: (data) => {
        const msg = decodeClientMessage(data);
        if (!msg) return;
        // After a handoff the old socket no longer speaks for the player.
        if (player && this.players.get(player.id) !== player) return;
        if (msg.t === "move" && player) {
          this.handleMove(player, msg);
        } else if (msg.t === "join" && !player && !joining) {
          if (!resume) {
            player = this.join(peer, msg, playerId);
            return;
          }
          joining = true;
          void resume.then((state) => {
            if (joining) player = this.join(peer, msg, playerId, state);
          });
        } else if (msg.t === "voice" && player) {
          this.handleVoice(player, msg.seq, msg.data);
        } else if (msg.t === "chat" && player) {
          this.handleChat(player, msg.text);
        } else if (msg.t === "set_role" && player) {
          this.handleSetRole(player, msg.id, msg.role);
        } else if (msg.t === "react" && player) {
          this.handleReact(player, msg.kind);
        } else if (msg.t === "hand" && player) {
          this.handleHand(player, msg.id, msg.up);
        } else if (msg.t === "poll_start" && player) {
          this.handlePollStart(player, msg.question, msg.options);
        } else if (msg.t === "poll_end" && player) {
          this.handlePollEnd(player);
        } else if (msg.t === "who" && player) {
          this.handleWho(player, msg.ids);
        } else if (msg.t === "gather" && player) {
          this.handleGather(player);
        } else if (msg.t === "release" && player) {
          this.handleRelease(player);
        }
      },
      close: () => {
        joining = false;
        if (player) this.leave(player);
        if (--this.connections === 0) {
          this.stopTicker();
          this.opts.onEmpty();
        }
      },
    };
  }

  // ------------------------------------------------------------ remote (mesh) side

  /** A player of another server appeared (or its full state arrived). */
  remoteJoined(owner: number, info: PlayerInfo): void {
    const existing = this.players.get(info.id);
    if (existing?.owner === null) return; // ours; a stale message
    const player: Player = { ...info, owner, peer: null, group: -1, cell: -1, gridCell: -1, ...fresh() };
    if (existing) this.unfile(existing);
    this.players.set(info.id, player);
    this.file(player);
    if (existing) {
      // Already shown to our clients: refresh its state instead of a second join.
      this.forget(existing);
      this.markChanged(player);
    } else {
      this.queueJoined(info.id);
    }
  }

  remoteLeft(owner: number, id: number): void {
    const p = this.players.get(id);
    if (!p || p.owner !== owner) return;
    this.players.delete(id);
    this.unfile(p);
    this.forget(p);
    this.queueLeft(id);
    this.pollMovers.delete(id);
    this.orbit?.slots.delete(id);
  }

  /** Replicated moves go out to our clients with our next tick. */
  remoteMoves(owner: number, states: PlayerState[]): void {
    for (const s of states) {
      const p = this.players.get(s.id);
      if (!p || p.owner !== owner) continue;
      p.x = s.x;
      p.y = s.y;
      p.dir = s.dir;
      p.moving = s.moving;
      p.movedAt = Date.now();
      this.file(p);
      this.markChanged(p);
      if (this.poll) this.pollMovers.add(p.id);
    }
  }

  remoteChat(message: ChatMessage): void {
    this.broadcast({ t: "chat", message });
  }

  /** The owner of a replica changed its role. */
  remoteRole(owner: number, id: number, role: Role): void {
    const p = this.players.get(id);
    if (!p || p.owner !== owner || p.role === role) return;
    p.role = role;
    this.broadcast({ t: "role", id, role });
  }

  /**
   * Another server asks us to change the role of one of our players: its host
   * chose (or dropped) a speaker, or a new host took over from ours. Servers
   * trust each other; the requesting server checked the host.
   */
  remoteSetRole(id: number, role: Role): void {
    const p = this.players.get(id);
    if (p?.owner === null && role !== "host") this.applyRole(p, role);
  }

  /** Voice frames from speakers connected to server `owner`, relayed with our next tick. */
  remoteVoice(owner: number, frames: VoiceFrame[]): void {
    for (const f of frames) {
      const p = this.players.get(f.id);
      if (p && p.owner === owner && canSpeak(p.role)) this.queueVoice(f);
    }
  }

  /** Reactions from players of server `owner`, relayed with our next snapshot. */
  remoteReactions(owner: number, list: Reaction[]): void {
    for (const r of list) if (this.players.get(r.id)?.owner === owner) this.queueReaction(r);
  }

  /** The owner of a replica raised or lowered its hand. */
  remoteHand(owner: number, id: number, hand: number): void {
    const p = this.players.get(id);
    if (!p || p.owner !== owner || p.hand === hand) return;
    p.hand = hand;
    this.queueHand(id, hand);
  }

  /** Another server's host lowered the hand of one of our players. */
  remoteSetHand(id: number, hand: number): void {
    const p = this.players.get(id);
    if (p?.owner === null && hand === 0) this.setHand(p, 0);
  }

  /** The host (on another server) started or ended a poll. */
  remotePoll(poll: Poll): void {
    if (poll.open) this.startPoll(poll);
    else if (this.poll?.id === poll.id) this.endPoll(poll);
  }

  /** The host (on another server) gathered everyone or let them go. */
  remoteOrbit(orbit: OrbitSync): void {
    if (orbit.active) this.startOrbit(orbit.start, new Map(orbit.slots.map((s) => [s.id, s.slot])));
    else if (this.orbit) this.releaseOrbit(orbit.at);
  }

  /** Seats another server gave its players. */
  remoteSlots(list: SlotChange[]): void {
    if (!this.orbit) return;
    for (const { id, slot } of list) {
      if (slot === NO_SLOT) this.orbit.slots.delete(id);
      else this.orbit.slots.set(id, slot);
      this.queueSlot(id, slot);
    }
  }

  /** A server went away: its players leave this room for our clients. */
  dropOwner(owner: number): void {
    for (const p of [...this.players.values()]) if (p.owner === owner) this.remoteLeft(owner, p.id);
  }

  // ------------------------------------------------------------ migration

  /**
   * Ask up to `count` random local players to reconnect elsewhere (the server is
   * shedding load). Returns the ids asked.
   */
  pickMigrants(count: number, now = Date.now()): number[] {
    for (const [id, until] of this.migrating) if (until <= now) this.migrating.delete(id);
    const candidates = [...this.players.values()].filter((p) => p.owner === null && !this.migrating.has(p.id));
    const picked: number[] = [];
    while (picked.length < count && candidates.length > 0) {
      const p = candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0];
      this.migrating.set(p.id, now + MIGRATE_RETRY_MS);
      send(p.peer!, { t: "migrate" });
      picked.push(p.id);
    }
    return picked;
  }

  /**
   * Another server took over this player's socket (takeover): keep it as a
   * replica owned by `newOwner` without telling anyone it left. Its old socket is
   * ignored from now on and closes quietly. Returns the state to hand over.
   */
  handOff(id: number, newOwner: number): PlayerInfo | null {
    const p = this.players.get(id);
    if (!p || p.owner !== null) return null;
    const info = toInfo(p);
    const replica = { ...p, owner: newOwner, peer: null, group: -1, cell: -1 };
    this.unfile(p);
    this.players.set(id, replica);
    this.file(replica);
    this.localCount--;
    this.groupSizes[p.group]--;
    this.removeViewer(p);
    this.forget(p);
    this.migrating.delete(id);
    this.applySchedule(this.localCount);
    return info;
  }

  // ------------------------------------------------------------ local side

  private join(
    peer: Peer,
    request: { name: unknown; appearance: unknown; hostKey: string },
    assignedId?: number,
    resume?: PlayerInfo | null,
  ): Player | null {
    const { name: rawName, appearance, hostKey } = request;
    const name = typeof rawName === "string" ? rawName.trim().slice(0, MAX_NAME_LENGTH) : "";
    if (!name || !isAppearanceId(appearance)) {
      send(peer, { t: "error", message: "Invalid name or appearance." });
      peer.close();
      return null;
    }
    if (assignedId !== undefined && this.players.get(assignedId)?.owner === null) {
      send(peer, { t: "error", message: "This seat is already taken; please rejoin." });
      peer.close();
      return null;
    }
    const id = assignedId ?? this.nextLocalId();

    // The host key makes this player the host (the sun); a migrating speaker stays one.
    const isHost = hostKey !== "" && (this.opts.isHostKey?.(hostKey) ?? false);
    const role: Role = isHost ? "host" : resume?.role === "speaker" ? "speaker" : "guest";
    if (isHost) this.dethroneHosts(id);

    // The host sits in the sun; a migrating player continues where it was; others
    // appear near someone in the room.
    const start = isHost
      ? { ...WORLD_CENTER, dir: "south" as const }
      : resume && canBeAt(resume.x, resume.y)
        ? resume
        : { ...this.spawnFor(id), dir: "south" as const };
    const wasReplica = this.players.get(id)?.owner != null;
    // Newcomers fill the smaller snapshot group.
    const group = this.groupSizes[0] <= this.groupSizes[1] ? 0 : 1;
    const player: Player = {
      id,
      owner: null,
      peer,
      group,
      cell: cellOf(start.x, start.y),
      gridCell: -1,
      name,
      appearance,
      x: start.x,
      y: start.y,
      dir: start.dir,
      moving: false,
      role,
      hand: role === "guest" ? (resume?.hand ?? 0) : 0,
      ...fresh(),
    };

    // Arriving during an orbit: straight to a seat.
    if (this.orbit && role !== "host") this.seat(player, this.orbit.slots.get(id));
    // Others hear about a change of snapshot rate before the newcomer's welcome carries it.
    this.applySchedule(this.localCount + 1);
    // A replica with our id (a migration, or a stale copy) is replaced in place.
    const others = [...this.players.values()].filter((p) => p.id !== id);
    send(peer, {
      t: "welcome",
      selfId: player.id,
      players: [...others, player].map(toInfo),
      chat: this.chat,
      snapshotHz: this.snapshotHz,
      poll: this.poll,
      orbit: this.orbitWire(),
    });
    // Our clients already see a migrating player; only its position may change.
    if (!wasReplica) this.queueJoined(player.id);
    if (this.publish) {
      if (!peer.subscribe) throw new Error("Room uses publish but the peer cannot subscribe");
      peer.subscribe(ROOM_CHANNEL);
      peer.subscribe(viewChannel(player.cell, group));
    }
    const replica = this.players.get(player.id);
    if (replica) this.unfile(replica);
    this.players.set(player.id, player);
    this.file(player);
    this.localCount++;
    this.groupSizes[group]++;
    this.viewersIn(player.cell).add(player);
    if (wasReplica) this.markChanged(player);
    this.startTicker();
    this.opts.onJoined?.(player.id);
    this.opts.sync?.joined(toInfo(player));
    return player;
  }

  /**
   * Groups and tick rate for `count` local players: two groups from
   * SNAPSHOT_GROUPS_AT (back to one below SNAPSHOT_GROUPS_OFF_BELOW), ticking
   * groups x the per-player rate. Players hear about a change of their rate.
   */
  private applySchedule(count: number): void {
    if (this.opts.schedule) return;
    const groups = this.groups === 1 ? (count >= SNAPSHOT_GROUPS_AT ? 2 : 1) : count < SNAPSHOT_GROUPS_OFF_BELOW ? 1 : 2;
    const perPlayer = count >= OVERCHARGE_FORCE_AT ? Math.min(this.rate, TICK_RATE / 2) : this.rate;
    const before = this.snapshotHz;
    this.groups = groups;
    if (perPlayer * groups !== this.tickHz) {
      this.tickHz = perPlayer * groups;
      if (this.ticker) {
        this.stopTicker();
        this.startTicker();
      }
    }
    if (this.snapshotHz !== before) this.broadcast({ t: "rate", snapshotHz: this.snapshotHz });
  }

  /**
   * Joins and leaves go out with each group's next snapshot (one frame per player
   * per tick however many arrive). The newcomer gets its own join and the ones
   * already in its welcome too; clients ignore players they already have.
   */
  private queueJoined(id: number): void {
    for (const g of this.pending) g.joined.add(id);
  }

  /** A join this group has not been told about yet cancels out instead. */
  private queueLeft(id: number): void {
    for (const g of this.pending) {
      if (!g.joined.delete(id)) g.left.push(id);
    }
  }

  /** Current state, so a role or position change since the join is not lost. */
  private joinedInfos(ids: Set<number>): PlayerInfo[] {
    const out: PlayerInfo[] = [];
    for (const id of ids) {
      const p = this.players.get(id);
      if (p) out.push(toInfo(p));
    }
    return out;
  }

  private markChanged(p: Player): void {
    this.tickChanged.add(p);
    for (const g of this.pending) g.changed.add(p);
  }

  private forget(p: Player): void {
    this.tickChanged.delete(p);
    for (const g of this.pending) g.changed.delete(p);
  }

  /** Somewhere near a player of the room (never the host, who sits in the sun). */
  private spawnFor(id: number): { x: number; y: number } {
    return spawnPoint([...this.players.values()].filter((p) => p.id !== id && p.role !== "host"));
  }

  /** Only one host at a time: whoever presented the key last wins (e.g. a second tab). */
  private dethroneHosts(newHost: number): void {
    for (const p of [...this.players.values()]) {
      if (p.role !== "host" || p.id === newHost) continue;
      if (p.owner === null) this.applyRole(p, "guest");
      else this.opts.sync?.setRole(p.owner, p.id, "guest");
    }
  }

  private speakerCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.role === "speaker") n++;
    return n;
  }

  private handleSetRole(requester: Player, id: number, role: "speaker" | "guest"): void {
    if (requester.role !== "host") {
      send(requester.peer!, { t: "error", message: "Only the host can choose speakers." });
      return;
    }
    const target = this.players.get(id);
    if (!target || target.role === "host" || target.role === role) return;
    if (role === "speaker" && this.speakerCount() >= MAX_SPEAKERS) {
      send(requester.peer!, { t: "error", message: `There can be at most ${MAX_SPEAKERS} speakers.` });
      return;
    }
    if (target.owner === null) this.applyRole(target, role);
    else this.opts.sync?.setRole(target.owner, id, role);
  }

  /** Change a local player's role and tell everyone. */
  private applyRole(p: Player, role: Role): void {
    if (p.role === role) return;
    const wasHost = p.role === "host";
    p.role = role;
    if (this.orbit) {
      // In orbit: the host goes to the sun, a new speaker to the stage, a guest to the rings.
      if (role === "host") this.unseat(p);
      else if (wasHost || (role === "speaker") !== (this.orbit.slots.get(p.id) ?? NO_SLOT) < STAGE_SLOTS) this.seat(p);
    } else if (wasHost) {
      // A former host leaves the sun for a spot near the others.
      const spot = this.spawnFor(p.id);
      p.x = spot.x;
      p.y = spot.y;
      p.lastMoveAt = p.movedAt = Date.now();
      this.markChanged(p);
      send(p.peer!, { t: "correction", x: p.x, y: p.y });
      this.file(p);
      this.moveViewer(p);
    }
    this.broadcast({ t: "role", id: p.id, role });
    this.opts.sync?.role(p.id, role);
    // Invited to speak (or made host): the hand did its job.
    if (role !== "guest") this.setHand(p, 0);
  }

  /**
   * A client saw players in snapshots it never got the join of (Bun drops frames
   * to a socket past its backpressure limit): tell it who they are, and which of
   * them are gone. Answered to that client only, at most every WHO_MIN_MS.
   */
  private handleWho(player: Player, ids: number[]): void {
    const now = Date.now();
    if (now - player.whoAt < WHO_MIN_MS) return;
    player.whoAt = now;
    const players: PlayerInfo[] = [];
    const missing: number[] = [];
    for (const id of new Set(ids)) {
      const p = this.players.get(id);
      if (p) players.push(toInfo(p));
      else missing.push(id);
    }
    send(player.peer!, { t: "players", players, missing });
  }

  // ------------------------------------------------------------ orbit mode

  /** The host gathers everyone around the sun: speakers on the stage ring, guests on the rings. */
  private handleGather(requester: Player): void {
    if (requester.role !== "host") {
      send(requester.peer!, { t: "error", message: "Only the host can gather everyone." });
      return;
    }
    if (this.orbit) return;
    // A poll needs people to fly to an answer; gathering ends it.
    if (this.poll) {
      const final: Poll = { ...this.poll, open: false, counts: this.countVotes(this.poll.options.length) };
      this.endPoll(final);
      this.opts.sync?.poll(final);
    }
    const slots = new Map<number, number>();
    let stage = 0;
    let ring = STAGE_SLOTS;
    for (const p of this.players.values()) {
      if (p.role === "host") continue;
      slots.set(p.id, p.role === "speaker" && stage < STAGE_SLOTS ? stage++ : ring++);
    }
    const start = Date.now();
    this.startOrbit(start, slots);
    this.opts.sync?.orbit({ active: true, start, slots: slotList(slots) });
  }

  private handleRelease(requester: Player): void {
    if (requester.role !== "host" || !this.orbit) return;
    const at = Date.now();
    this.releaseOrbit(at);
    this.opts.sync?.orbit({ active: false, at });
  }

  private startOrbit(start: number, slots: Map<number, number>): void {
    this.orbit = { start, slots };
    for (const g of this.pending) g.slots.clear();
    this.broadcast({ t: "orbit", active: true, ...this.orbitWire()! });
  }

  /**
   * Everyone stays where their orbit had them at `at`. Clients compute the same
   * spots, so nobody is told; we only refile players for the area of interest.
   */
  private releaseOrbit(at: number): void {
    const orbit = this.orbit!;
    for (const [id, slot] of orbit.slots) {
      const p = this.players.get(id);
      if (!p) continue;
      const spot = orbitPosition(slot, (at - orbit.start) / 1000);
      p.x = quantize(spot.x);
      p.y = quantize(spot.y);
      p.dir = spot.dir;
      p.moving = false;
      p.lastMoveAt = p.movedAt = at;
      this.file(p);
      if (p.owner === null) this.moveViewer(p, false);
    }
    this.orbit = null;
    for (const g of this.pending) g.slots.clear();
    this.broadcast({ t: "orbit", active: false, start: orbit.start % 0x1_0000_0000, now: at % 0x1_0000_0000, slots: [] });
  }

  /** Give a local player a seat (`slot`, or the best free one for its role) and tell everyone. */
  private seat(p: Player, slot?: number): void {
    const orbit = this.orbit!;
    orbit.slots.delete(p.id);
    const seat = slot ?? freeSlot(p.role === "speaker", orbit.slots.values());
    orbit.slots.set(p.id, seat);
    const spot = orbitPosition(seat, (Date.now() - orbit.start) / 1000);
    p.x = quantize(spot.x);
    p.y = quantize(spot.y);
    this.queueSlot(p.id, seat);
    this.opts.sync?.slots([{ id: p.id, slot: seat }]);
  }

  private unseat(p: Player): void {
    if (!this.orbit?.slots.delete(p.id)) return;
    this.queueSlot(p.id, NO_SLOT);
    this.opts.sync?.slots([{ id: p.id, slot: NO_SLOT }]);
  }

  private queueSlot(id: number, slot: number): void {
    for (const g of this.pending) g.slots.set(id, slot);
  }

  /** The orbit as clients get it: start and our clock now (both modulo 2^32), and every seat. */
  private orbitWire(): OrbitState | null {
    if (!this.orbit) return null;
    return { start: this.orbit.start % 0x1_0000_0000, now: Date.now() % 0x1_0000_0000, slots: slotList(this.orbit.slots) };
  }

  // ------------------------------------------------------------ reactions, hands, polls

  private handleReact(player: Player, kind: number): void {
    const now = Date.now();
    player.reactBudget = Math.min(
      REACTION_BURST,
      player.reactBudget + ((now - player.reactAt) / 1000) * REACTIONS_PER_SEC,
    );
    player.reactAt = now;
    if (player.reactBudget < 1) return;
    player.reactBudget -= 1;
    const reaction = { id: player.id, kind };
    this.queueReaction(reaction);
    if (this.opts.sync) this.localReactions.push(reaction);
  }

  private queueReaction(reaction: Reaction): void {
    for (const g of this.pending) if (g.reactions.length < MAX_REACTIONS_PER_SNAPSHOT) g.reactions.push(reaction);
  }

  /** Guests raise and lower their own hand; the host may lower anyone's. */
  private handleHand(requester: Player, id: number, up: boolean): void {
    if (id === requester.id) {
      if (up && requester.role !== "guest") return;
      if (up !== (requester.hand !== 0)) this.setHand(requester, up ? handTicket() : 0);
      return;
    }
    if (up || requester.role !== "host") return;
    const target = this.players.get(id);
    if (!target || target.hand === 0) return;
    if (target.owner === null) this.setHand(target, 0);
    else this.opts.sync?.setHand(target.owner, id, 0);
  }

  /** Change a local player's hand; everyone hears with the next snapshot. */
  private setHand(p: Player, hand: number): void {
    if (p.hand === hand) return;
    p.hand = hand;
    this.queueHand(p.id, hand);
    this.opts.sync?.hand(p.id, hand);
  }

  private queueHand(id: number, hand: number): void {
    for (const g of this.pending) g.hands.set(id, hand);
  }

  private handlePollStart(requester: Player, question: string, options: string[]): void {
    if (requester.role !== "host") {
      send(requester.peer!, { t: "error", message: "Only the host can start a poll." });
      return;
    }
    if (this.orbit) {
      send(requester.peer!, { t: "error", message: "Polls are off while everyone is gathered." });
      return;
    }
    const clean = cleanPoll(question, options);
    if (!clean) {
      send(requester.peer!, { t: "error", message: "A poll needs a question and 2 to 4 answers." });
      return;
    }
    const poll: Poll = { id: (Math.random() * 0x1_0000_0000) >>> 0, ...clean, open: true, counts: [] };
    this.startPoll(poll);
    this.opts.sync?.poll(this.poll!);
  }

  private handlePollEnd(requester: Player): void {
    if (requester.role !== "host" || !this.poll) return;
    const final: Poll = { ...this.poll, open: false, counts: this.countVotes(this.poll.options.length) };
    this.endPoll(final);
    this.opts.sync?.poll(final);
  }

  /** A new poll replaces any open one; counts start from where everyone is now. */
  private startPoll(poll: Poll): void {
    if (this.poll?.id !== poll.id) this.pollMovers.clear();
    this.poll = { ...poll, counts: this.countVotes(poll.options.length) };
    this.pollCountedAt = Date.now();
    for (const g of this.pending) g.pollCounts = null;
    this.broadcast({ t: "poll", poll: this.poll });
  }

  private endPoll(final: Poll): void {
    this.poll = null;
    this.pollMovers.clear();
    for (const g of this.pending) g.pollCounts = null;
    this.broadcast({ t: "poll", poll: final });
  }

  /** Votes are positions: everyone who flew since the poll started, by the answer planet they are in. */
  private countVotes(options: number): number[] {
    const counts = new Array<number>(options).fill(0);
    for (const id of this.pollMovers) {
      const p = this.players.get(id);
      if (!p || p.role === "host") continue;
      const zone = pollZoneAt(p.x, p.y, options);
      if (zone >= 0) counts[zone]++;
    }
    return counts;
  }

  private recountPoll(now: number): void {
    const poll = this.poll;
    if (!poll || now - this.pollCountedAt < POLL_COUNT_MS) return;
    this.pollCountedAt = now;
    const counts = this.countVotes(poll.options.length);
    if (counts.every((n, i) => n === poll.counts[i])) return;
    poll.counts = counts;
    for (const g of this.pending) g.pollCounts = counts;
  }

  private handleVoice(player: Player, seq: number, data: Uint8Array): void {
    if (!canSpeak(player.role) || data.byteLength === 0 || data.byteLength > MAX_VOICE_FRAME_BYTES) return;
    const now = Date.now();
    player.voiceBudget = Math.min(
      VOICE_BYTES_PER_SEC,
      player.voiceBudget + ((now - player.voiceAt) / 1000) * VOICE_BYTES_PER_SEC,
    );
    player.voiceAt = now;
    if (player.voiceBudget < data.byteLength) return;
    player.voiceBudget -= data.byteLength;
    const frame = { id: player.id, seq, data };
    if (this.queueVoice(frame) && this.opts.sync) this.localVoice.push(frame);
  }

  private queueVoice(frame: VoiceFrame): boolean {
    let queued = false;
    for (const g of this.pending) {
      if (g.voice.length >= MAX_PENDING_VOICE) continue;
      if (g.voice.length === 0) g.voiceSince = Date.now();
      g.voice.push(frame);
      queued = true;
    }
    return queued;
  }

  /** Standalone ids: a per-room counter that skips ids still in use. */
  private nextLocalId(): number {
    for (;;) {
      if (this.nextPlayerId > 0xffff) this.nextPlayerId = 1;
      const id = this.nextPlayerId++;
      if (!this.players.has(id)) return id;
    }
  }

  private leave(player: Player): void {
    if (this.players.get(player.id) !== player) return;
    this.players.delete(player.id);
    this.unfile(player);
    this.localCount--;
    this.groupSizes[player.group]--;
    this.removeViewer(player);
    this.forget(player);
    this.queueLeft(player.id);
    this.pollMovers.delete(player.id);
    this.orbit?.slots.delete(player.id);
    this.applySchedule(this.localCount);
    this.opts.onLeft?.(player.id);
    this.opts.sync?.left(player.id);
  }

  private handleMove(player: Player, move: { x: number; y: number; dir: Direction; moving: boolean }): void {
    if (player.role === "host") return; // the sun does not move
    if (this.orbit) return; // gathered: everyone follows their orbit
    const now = Date.now();
    const elapsed = Math.min((now - player.lastMoveAt) / 1000, 1);
    const maxDistance = MOVE_SPEED * elapsed + MOVE_SLACK;
    const dx = move.x - player.x;
    const dy = move.y - player.y;

    if (dx * dx + dy * dy > maxDistance * maxDistance || !canBeAt(move.x, move.y)) {
      send(player.peer!, { t: "correction", x: player.x, y: player.y });
      return;
    }

    player.x = move.x;
    player.y = move.y;
    player.dir = move.dir;
    player.moving = move.moving;
    player.lastMoveAt = now;
    player.movedAt = now;
    this.file(player);
    this.markChanged(player);
    this.moveViewer(player);
    if (this.poll) this.pollMovers.add(player.id);
  }

  // ------------------------------------------------------------ area of interest

  /** File the player under the grid cell of its position. */
  private file(p: Player): void {
    const cell = cellOf(p.x, p.y);
    const set = this.grid.get(cell);
    if (cell === p.gridCell && set?.has(p)) return;
    this.unfile(p);
    p.gridCell = cell;
    if (set) set.add(p);
    else this.grid.set(cell, new Set([p]));
  }

  private unfile(p: Player): void {
    const set = this.grid.get(p.gridCell);
    if (!set?.delete(p)) return;
    if (set.size === 0) this.grid.delete(p.gridCell);
  }

  private viewersIn(cell: number): Set<Player> {
    let set = this.viewers.get(cell);
    if (!set) this.viewers.set(cell, (set = new Set()));
    return set;
  }

  private removeViewer(p: Player): void {
    const set = this.viewers.get(p.cell);
    set?.delete(p);
    if (set?.size === 0) this.viewers.delete(p.cell);
  }

  /**
   * A local player moved: when it enters another cell it switches snapshot
   * channels and gets everyone in the part of the map that just came into view,
   * idle players included (their positions never come in snapshots otherwise).
   * The rest of its view was in view already, so it is up to date.
   */
  /** `tell` false: the client already knows who is around (orbit release). */
  private moveViewer(p: Player, tell = true): void {
    const cell = cellOf(p.x, p.y);
    const from = p.cell;
    if (cell === from) return;
    if (this.publish) {
      p.peer!.unsubscribe?.(viewChannel(p.cell, p.group));
      p.peer!.subscribe!(viewChannel(cell, p.group));
    }
    this.removeViewer(p);
    p.cell = cell;
    this.viewersIn(cell).add(p);
    if (!tell) return;
    const players: PlayerState[] = [];
    for (const near of cellsInView(cell)) {
      // Cells the old view covered entirely hold nobody new.
      if (cellFullyInView(near, from)) continue;
      for (const q of this.grid.get(near) ?? []) {
        if (q !== p && inView(q.x, q.y, cell) && !inView(q.x, q.y, from)) players.push(toState(q));
      }
    }
    send(p.peer!, { t: "view", from, to: cell, players });
  }

  private handleChat(player: Player, rawText: unknown): void {
    if (typeof rawText !== "string") return;
    const text = rawText.trim().slice(0, MAX_CHAT_LENGTH);
    if (!text) return;

    const now = Date.now();
    player.chatTimes = player.chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
    if (player.chatTimes.length >= CHAT_BURST) {
      send(player.peer!, { t: "error", message: "You are sending messages too fast." });
      return;
    }
    player.chatTimes.push(now);

    // Chat ids fit a UInt32: the server's base (serverId * 2^24 in cluster mode) plus a counter.
    const id = (this.opts.chatIdBase ?? 0) + (this.nextChatId++ % 0x1000000);
    const message: ChatMessage = { id, playerId: player.id, name: player.name, text, ts: now };
    if (this.opts.keepChatHistory ?? true) {
      this.chat.push(message);
      if (this.chat.length > CHAT_HISTORY_SIZE) this.chat.shift();
    }
    this.broadcast({ t: "chat", message });
    this.opts.sync?.chat(message);
  }

  private startTicker(): void {
    this.ticker ??= setInterval(() => this.tick(), 1000 / this.tickHz);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /**
   * Send only the players that changed; idle players cost nothing. The stream
   * is reliable and ordered, and "welcome" carries everyone's full state, so
   * clients can keep the last known state of anyone missing from a snapshot.
   * Voice frames ride the snapshot when there is one, so a talking speaker costs
   * no extra sends; in a room where nobody moves they wait up to VOICE_FLUSH_MS
   * and go out alone, half as many sends as one per tick (docs/voice.md).
   *
   * Big rooms use two snapshot groups served on alternate ticks: each player gets
   * 10 Hz, and each tick's burst of sends covers half the room. A group's snapshot
   * holds everything since its own last one.
   *
   * Local changes and voice are mirrored to other servers every tick (a handful
   * of peers, and the receiving server batches again for its clients).
   */
  private tick(now = Date.now()): void {
    const start = performance.now();
    this.ticks++;
    // The mesh stays at TICK_RATE whatever the room's tick rate.
    if (this.ticks % Math.max(1, Math.round(this.tickHz / TICK_RATE)) === 0) {
      if (this.opts.sync) {
        if (this.localVoice.length > 0) this.opts.sync.voice(this.localVoice);
        if (this.localReactions.length > 0) this.opts.sync.reactions(this.localReactions);
        const local = [...this.tickChanged].filter((p) => p.owner === null);
        if (local.length > 0) this.opts.sync.moves(local.map(toState));
      }
      this.localVoice = [];
      this.localReactions = [];
      this.tickChanged.clear();
    }
    this.recountPoll(now);
    let sent: boolean;
    if (this.groups === 2) {
      sent = this.flush([this.ticks % 2], now);
      this.diverged = true;
    } else if (this.diverged) {
      // Just back to one group: each group still has its own backlog.
      sent = this.flush([0], now);
      sent = this.flush([1], now) || sent;
      this.diverged = false;
    } else {
      sent = this.flush([0, 1], now);
    }
    if (sent) recordTick(performance.now() - start);
  }

  /**
   * Send groups whose pending state is identical (the first group's) their
   * snapshots: one per map cell with viewers, holding the changed players in view
   * of that cell, the host and speakers wherever they are, and the voice.
   */
  private flush(groups: number[], now: number): boolean {
    const p = this.pending[groups[0]];
    // Idle rooms batch voice to VOICE_FLUSH_MS: send now when waiting for this
    // group's next snapshot would make the oldest frame older than that.
    const periodMs = 1000 / this.snapshotHz;
    const voiceDue =
      p.voice.length > 0 && (p.changed.size > 0 || now - p.voiceSince + periodMs >= VOICE_FLUSH_MS);
    // Joins, leaves, reactions, hands and poll counts go out with the next snapshot.
    const extras =
      p.joined.size > 0 ||
      p.left.length > 0 ||
      p.reactions.length > 0 ||
      p.hands.size > 0 ||
      p.pollCounts !== null ||
      p.slots.size > 0;
    if (p.changed.size === 0 && !voiceDue && !extras) return false;
    const voice = voiceDue ? p.voice : [];
    // Each part is encoded once and copied into the snapshots of every cell that sees it.
    const tail = snapshotTail({
      time: now % 0x1_0000_0000,
      voice,
      joined: this.joinedInfos(p.joined),
      left: p.left,
      reactions: p.reactions,
      hands: [...p.hands].map(([id, hand]) => ({ id, hand })),
      pollCounts: p.pollCounts ?? [],
      slots: slotList(p.slots),
    });

    // The host and speakers are always in view; everyone else by map cell.
    const stage: Uint8Array[] = [];
    const byCell = new Map<number, { p: Player; entry: Uint8Array }[]>();
    for (const q of p.changed) {
      const entry = snapshotEntry(q, now - q.movedAt);
      if (q.role !== "guest") {
        stage.push(entry);
        continue;
      }
      const cell = cellOf(q.x, q.y);
      const list = byCell.get(cell);
      if (list) list.push({ p: q, entry });
      else byCell.set(cell, [{ p: q, entry }]);
    }

    const counts = groups.map(() => 0);
    for (const [cell, viewers] of this.viewers) {
      counts.fill(0);
      for (const v of viewers) {
        const i = groups.indexOf(v.group);
        if (i >= 0) counts[i]++;
      }
      if (counts.every((n) => n === 0)) continue;
      const entries = stage.slice();
      const near = cellsInView(cell);
      // Walk whichever is shorter: the cells around this one, or the cells with movers.
      if (byCell.size < near.length) {
        const nearSet = cellSetInView(cell);
        for (const [other, movers] of byCell) {
          if (nearSet.has(other)) for (const m of movers) if (inView(m.p.x, m.p.y, cell)) entries.push(m.entry);
        }
      } else {
        for (const other of near) {
          const movers = byCell.get(other);
          if (movers) for (const m of movers) if (inView(m.p.x, m.p.y, cell)) entries.push(m.entry);
        }
      }
      if (entries.length === 0 && voice.length === 0 && !extras) continue;
      const data = assembleSnapshot(entries, tail);
      groups.forEach((g, i) => {
        if (counts[i] > 0) this.publishView(cell, g, viewers, data, counts[i]);
      });
    }
    for (const g of groups) {
      this.pending[g].changed.clear();
      this.pending[g].joined.clear();
      this.pending[g].left = [];
      this.pending[g].reactions = [];
      this.pending[g].hands.clear();
      this.pending[g].pollCounts = null;
      this.pending[g].slots.clear();
      if (voiceDue) this.pending[g].voice = [];
    }
    return true;
  }

  private publishView(cell: number, group: number, viewers: Set<Player>, data: Uint8Array, recipients: number): void {
    recordEgress(data.byteLength * recipients);
    if (this.publish) this.publish(viewChannel(cell, group), data);
    else for (const v of viewers) if (v.group === group) v.peer?.send(data);
  }

  /** Encode once, send to every local player. */
  private broadcast(msg: ServerMessage): void {
    this.publishTo(ROOM_CHANNEL, () => true, encodeServerMessage(msg), this.localCount);
  }

  private publishTo(channel: string, member: (p: Player) => boolean, data: Uint8Array, recipients: number): void {
    if (this.localCount === 0) return;
    recordEgress(data.byteLength * recipients);
    if (this.publish) this.publish(channel, data);
    else for (const p of this.players.values()) if (p.peer && member(p)) p.peer.send(data);
  }
}

function send(peer: Peer, msg: ServerMessage): void {
  peer.send(encodeServerMessage(msg));
}

function toInfo(p: Player): PlayerInfo {
  return {
    id: p.id,
    name: p.name,
    appearance: p.appearance,
    x: p.x,
    y: p.y,
    dir: p.dir,
    moving: p.moving,
    role: p.role,
    hand: p.hand,
  };
}

function newPending(): Pending {
  return {
    changed: new Set(),
    voice: [],
    voiceSince: 0,
    joined: new Set(),
    left: [],
    reactions: [],
    hands: new Map(),
    pollCounts: null,
    slots: new Map(),
  };
}

/** Per-player bookkeeping that starts over on every server. */
function fresh() {
  const now = Date.now();
  return {
    lastMoveAt: now,
    movedAt: now,
    whoAt: 0,
    chatTimes: [] as number[],
    voiceBudget: VOICE_BYTES_PER_SEC,
    voiceAt: now,
    reactBudget: REACTION_BURST,
    reactAt: now,
  };
}

function slotList(slots: Map<number, number>): SlotChange[] {
  return [...slots].map(([id, slot]) => ({ id, slot }));
}

function toState(p: Player): PlayerState {
  return { id: p.id, x: p.x, y: p.y, dir: p.dir, moving: p.moving };
}
