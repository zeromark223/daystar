import { isAppearanceId, type AppearanceId } from "../../shared/src/appearance.ts";
import {
  CHAT_HISTORY_SIZE,
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SPEAKERS,
  MAX_VOICE_FRAME_BYTES,
  MOVE_SPEED,
  SNAPSHOT_GROUPS_AT,
  SNAPSHOT_GROUPS_OFF_BELOW,
  TICK_RATE,
  VOICE_BYTES_PER_SEC,
  VOICE_FLUSH_MS,
  WORLD_CENTER,
} from "../../shared/src/constants.ts";
import type { Direction } from "../../shared/src/direction.ts";
import { canSpeak, type Role } from "../../shared/src/roles.ts";
import { canBeAt, spawnPoint } from "../../shared/src/space.ts";
import { recordTick } from "./stats.ts";
import {
  decodeClientMessage,
  encodeServerMessage,
  type ChatMessage,
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
/** Voice frames held for one tick at most (a tick normally carries 2-3 per speaker). */
const MAX_PENDING_VOICE = 200;

/** A connected client, whatever the runtime's WebSocket implementation is. */
export interface Peer {
  send(data: Uint8Array): void;
  close(): void;
  /**
   * Join one of the room's broadcast channels: ROOM_CHANNEL (events for everyone)
   * and the player's snapshot group channel. Only needed when the room has a
   * `publish` function (Bun topics); called once the player has joined.
   */
  subscribe?(channel: string): void;
}

/** Channel for events every player gets (joins, chat, roles...). */
export const ROOM_CHANNEL = "";
/** Channel of snapshot group `g` (see SNAPSHOT_GROUPS_AT). */
export const groupChannel = (g: number) => `g${g}`;

/**
 * Sends one frame to every peer subscribed to one of the room's channels in a
 * single call (Bun's server.publish fans out natively). Without it the room loops over peers.
 */
export type Publish = (channel: string, data: Uint8Array) => void;

/** Changes and voice a snapshot group has not been sent yet. */
interface Pending {
  changed: Set<Player>;
  voice: VoiceFrame[];
  /** When the oldest frame in `voice` arrived (Date.now()). */
  voiceSince: number;
}

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
}

interface Player {
  id: number;
  /** null: this server holds the player's socket and is authoritative. Else the owning server. */
  owner: number | null;
  /** The socket, for local players only. */
  peer: Peer | null;
  /** Snapshot group (0 or 1), for local players only. */
  group: number;
  name: string;
  appearance: AppearanceId;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
  role: Role;
  lastMoveAt: number;
  chatTimes: number[];
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
  private readonly tickHz: number;
  private readonly groupSizes = [0, 0];
  private ticks = 0;
  /** Per group: players (local or replicated) changed and voice received since its last snapshot. */
  private readonly pending: Pending[] = [newPending(), newPending()];
  /** The groups' pending sets differ (after a 2-group tick); they are flushed separately. */
  private diverged = false;
  /** Players changed during the current tick, and local voice frames, for the mesh. */
  private readonly tickChanged = new Set<Player>();
  private localVoice: VoiceFrame[] = [];
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Local players asked to migrate, and when they may be asked again. */
  private readonly migrating = new Map<number, number>();
  private readonly publish: Publish | null;
  private readonly opts: RoomOptions;

  constructor(id: string, opts: RoomOptions) {
    this.id = id;
    this.publish = opts.publish ?? null;
    this.opts = opts;
    this.tickHz = opts.schedule?.tickHz ?? TICK_RATE;
    this.groups = opts.schedule?.groups ?? 1;
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
    const player: Player = { ...info, owner, peer: null, group: -1, ...fresh() };
    this.players.set(info.id, player);
    if (existing) {
      // Already shown to our clients: refresh its state instead of a second join.
      this.forget(existing);
      this.markChanged(player);
    } else {
      this.broadcast({ t: "player_joined", player: info });
    }
  }

  remoteLeft(owner: number, id: number): void {
    const p = this.players.get(id);
    if (!p || p.owner !== owner) return;
    this.players.delete(id);
    this.forget(p);
    this.broadcast({ t: "player_left", id });
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
      this.markChanged(p);
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
    this.players.set(id, { ...p, owner: newOwner, peer: null, group: -1 });
    this.localCount--;
    this.groupSizes[p.group]--;
    this.forget(p);
    this.migrating.delete(id);
    this.updateGroups(this.localCount);
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
      name,
      appearance,
      x: start.x,
      y: start.y,
      dir: start.dir,
      moving: false,
      role,
      ...fresh(),
    };

    // Others hear about a change of snapshot rate before the newcomer's welcome carries it.
    this.updateGroups(this.localCount + 1);
    // A replica with our id (a migration, or a stale copy) is replaced in place.
    const others = [...this.players.values()].filter((p) => p.id !== id);
    send(peer, {
      t: "welcome",
      selfId: player.id,
      players: [...others, player].map(toInfo),
      chat: this.chat,
      snapshotHz: this.snapshotHz,
    });
    // Our clients already see a migrating player; only its position may change.
    if (!wasReplica) this.broadcast({ t: "player_joined", player: toInfo(player) });
    // Subscribe after the announcement so the newcomer does not receive its own join.
    if (this.publish) {
      if (!peer.subscribe) throw new Error("Room uses publish but the peer cannot subscribe");
      peer.subscribe(ROOM_CHANNEL);
      peer.subscribe(groupChannel(group));
    }
    this.players.set(player.id, player);
    this.localCount++;
    this.groupSizes[group]++;
    if (wasReplica) this.markChanged(player);
    this.startTicker();
    this.opts.onJoined?.(player.id);
    this.opts.sync?.joined(toInfo(player));
    return player;
  }

  /** Two snapshot groups from SNAPSHOT_GROUPS_AT local players, back to one below SNAPSHOT_GROUPS_OFF_BELOW. */
  private updateGroups(count: number): void {
    if (this.opts.schedule) return;
    const next = this.groups === 1 ? (count >= SNAPSHOT_GROUPS_AT ? 2 : 1) : count < SNAPSHOT_GROUPS_OFF_BELOW ? 1 : 2;
    if (next === this.groups) return;
    this.groups = next;
    this.broadcast({ t: "rate", snapshotHz: this.snapshotHz });
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
    if (wasHost) {
      // A former host leaves the sun for a spot near the others.
      const spot = this.spawnFor(p.id);
      p.x = spot.x;
      p.y = spot.y;
      p.lastMoveAt = Date.now();
      this.markChanged(p);
      send(p.peer!, { t: "correction", x: p.x, y: p.y });
    }
    this.broadcast({ t: "role", id: p.id, role });
    this.opts.sync?.role(p.id, role);
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
    this.localCount--;
    this.groupSizes[player.group]--;
    this.forget(player);
    this.broadcast({ t: "player_left", id: player.id });
    this.updateGroups(this.localCount);
    this.opts.onLeft?.(player.id);
    this.opts.sync?.left(player.id);
  }

  private handleMove(player: Player, move: { x: number; y: number; dir: Direction; moving: boolean }): void {
    if (player.role === "host") return; // the sun does not move
    const now = Date.now();
    const elapsed = Math.min((now - player.lastMoveAt) / 1000, 1);
    const maxDistance = MOVE_SPEED * elapsed + MOVE_SLACK;
    const distance = Math.hypot(move.x - player.x, move.y - player.y);

    if (distance > maxDistance || !canBeAt(move.x, move.y)) {
      send(player.peer!, { t: "correction", x: player.x, y: player.y });
      return;
    }

    player.x = move.x;
    player.y = move.y;
    player.dir = move.dir;
    player.moving = move.moving;
    player.lastMoveAt = now;
    this.markChanged(player);
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
        const local = [...this.tickChanged].filter((p) => p.owner === null);
        if (local.length > 0) this.opts.sync.moves(local.map(toState));
      }
      this.localVoice = [];
      this.tickChanged.clear();
    }
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

  /** Send groups whose pending state is identical one snapshot (the first group's). */
  private flush(groups: number[], now: number): boolean {
    const p = this.pending[groups[0]];
    // Idle rooms batch voice to VOICE_FLUSH_MS: send now when waiting for this
    // group's next snapshot would make the oldest frame older than that.
    const periodMs = 1000 / this.snapshotHz;
    const voiceDue =
      p.voice.length > 0 && (p.changed.size > 0 || now - p.voiceSince + periodMs >= VOICE_FLUSH_MS);
    if (p.changed.size === 0 && !voiceDue) return false;
    const data = encodeServerMessage({ t: "snapshot", players: [...p.changed], voice: voiceDue ? p.voice : [] });
    for (const g of groups) {
      this.pending[g].changed.clear();
      if (voiceDue) this.pending[g].voice = [];
      this.publishTo(groupChannel(g), (q) => q.group === g, data);
    }
    return true;
  }

  /** Encode once, send to every local player. */
  private broadcast(msg: ServerMessage): void {
    this.publishTo(ROOM_CHANNEL, () => true, encodeServerMessage(msg));
  }

  private publishTo(channel: string, member: (p: Player) => boolean, data: Uint8Array): void {
    if (this.localCount === 0) return;
    if (this.publish) this.publish(channel, data);
    else for (const p of this.players.values()) if (p.peer && member(p)) p.peer.send(data);
  }
}

function send(peer: Peer, msg: ServerMessage): void {
  peer.send(encodeServerMessage(msg));
}

function toInfo(p: Player): PlayerInfo {
  return { id: p.id, name: p.name, appearance: p.appearance, x: p.x, y: p.y, dir: p.dir, moving: p.moving, role: p.role };
}

function newPending(): Pending {
  return { changed: new Set(), voice: [], voiceSince: 0 };
}

/** Per-player bookkeeping that starts over on every server. */
function fresh() {
  const now = Date.now();
  return { lastMoveAt: now, chatTimes: [] as number[], voiceBudget: VOICE_BYTES_PER_SEC, voiceAt: now };
}

function toState(p: Player): PlayerState {
  return { id: p.id, x: p.x, y: p.y, dir: p.dir, moving: p.moving };
}
