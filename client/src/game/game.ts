import { Application, Container, Rectangle } from "pixi.js";
import { appearanceOf } from "../../../shared/src/appearance.ts";
import { MOVE_SPEED, TICK_RATE } from "../../../shared/src/constants.ts";
import { facing, type Direction } from "../../../shared/src/direction.ts";
import {
  FRESH_VIEW,
  quantize,
  type OrbitState,
  type PlayerInfo,
  type PlayerState,
  type SnapshotPlayer,
} from "../../../shared/src/protocol.ts";
import { fogAt, inView } from "../../../shared/src/aoi.ts";
import type { Role } from "../../../shared/src/roles.ts";
import { canBeAt, moveInSpace } from "../../../shared/src/space.ts";
import { Avatar } from "./avatar.ts";
import { KeyboardInput } from "./input.ts";
import { Minimap } from "./minimap.ts";
import { PollZones } from "./poll-zones.ts";
import { PlayoutClock, Track } from "./timeline.ts";
import { TeleportFx } from "./teleport.ts";
import {
  BURST_TRAIL_POINTS,
  BurstTrails,
  CORONA_BURST_AT,
  CORONA_MS_TOTAL,
  CORONA_OUT_MS,
  CORONA_OUT_STAGGER_MS,
  CoronaEffect,
  MAX_BURST_TRAILS,
} from "./corona.ts";
import type { Poll } from "../../../shared/src/poll.ts";
import { FIRST_RING, orbitPosition, RING_GAP, SEAT_SPACING, STAGE_SLOTS } from "../../../shared/src/orbit.ts";
import { SUN_RADIUS, WORLD_CENTER } from "../../../shared/src/constants.ts";
import { SpaceScene } from "./space-scene.ts";
import { TouchStick } from "./touch.ts";

export interface GameCallbacks {
  sendMove(x: number, y: number, dir: Direction, moving: boolean): void;
  /** How loud a player is talking right now, 0..1. */
  voiceLevel(id: number): number;
  /** The host tapped a player (screen coordinates of the tap). */
  pick(id: number, screenX: number, screenY: number): void;
}

const SEND_INTERVAL_MS = 1000 / TICK_RATE;
/**
 * Gather, in three movements: everyone spirals in towards the sun (IN), whirls
 * around it in a ring of light (SWIRL), then the sun flares and they fly out to
 * their seats (OUT). Each player starts up to GATHER_JITTER_MS late, so it does
 * not look mechanical.
 */
const GATHER_IN_MS = 1_300;
const GATHER_SWIRL_MS = 1_200;
const GATHER_OUT_MS = 1_200;
const GATHER_JITTER_MS = 200;
/** The whirl: just outside the sun, a ring this thick, about one turn a second. */
const SWIRL_RADIUS = SUN_RADIUS + 60;
const SWIRL_THICKNESS = 120;
const SWIRL_SPEED = (2 * Math.PI * 1.1) / 1000;
/** How the gather looks for this viewer (Corona by default; see ui/settings.ts). */
export type GatherStyle = "flight" | "corona";

/** Frame times while a gather plays, for comparing the two styles. */
interface GatherStats {
  style: GatherStyle | "release";
  players: number;
  frames: number;
  avgFps: number;
  p95FrameMs: number;
  worstFrameMs: number;
}

/**
 * At most this many players draw a trail each frame, the ones nearest the middle
 * of the screen. Trails used to be Graphics rebuilt every frame and needed a
 * budget of 60 (301 players in orbit: 28 fps with every trail); as rope meshes
 * all 301 have one at 60 fps, and this only guards very big rooms.
 */
const TRAIL_BUDGET = 400;

/**
 * Release: each player fades out of its seat at a moment between 0 and
 * RELEASE_SPREAD_MS that the server's seed gives (the same on every screen), and
 * fades in where it was before the gather. Opacity only: cheap on any device.
 */
const RELEASE_SPREAD_MS = 1_400;
const RELEASE_FADE_OUT_MS = 280;
const RELEASE_FADE_IN_MS = 350;
/** If the fresh view never comes (a dropped frame), stop waiting after this. */
const RELEASE_GIVE_UP_MS = 4_000;

/** A player changing seat mid-orbit (made speaker, ...) glides there in this long. */
const RESEAT_MS = 1_200;
/** While the gather plays the camera eases to the sun (this fast, per ms) and zooms out to see it all. */
const CAMERA_EASE_PER_MS = 1 / 600;

/** Corona burst: each player's white-hot trail covers this much of its path, this wide on screen. */
const BURST_TRAIL_MS = 220;
const BURST_TRAIL_PX = 33;
/** A gathering player's trail gets a point every this many ms of its path, whatever the frame rate. */
const GATHER_TRAIL_STEP_MS = 12;

const easeOut = (k: number) => 1 - (1 - k) ** 3;
const TAU = 2 * Math.PI;
const ARRIVE_DISTANCE = 3;
const MIN_ZOOM = 0.12;
const MAX_ZOOM = 2.5;
/** The host sees more of the room around the sun. */
const HOST_ZOOM = 0.45;
/** A tap this close to a player (screen px) picks it. */
const PICK_RADIUS = 34;

export class Game {
  private readonly app: Application;
  private readonly callbacks: GameCallbacks;
  private readonly scene = new SpaceScene();
  private readonly minimap = new Minimap();
  /** The world, scaled by the zoom: backdrop, trails, bodies. */
  private readonly world = new Container();
  private readonly trails = new Container();
  private readonly bodies = new Container();
  private readonly pollZones = new PollZones();
  /** Server time to draw remote players at (see timeline.ts). */
  private readonly clock = new PlayoutClock();
  /** Orbit mode: when it started (server time) and everyone's seat; positions come from the clock. */
  private orbit: { start: number; slots: Map<number, number> } | null = null;
  /**
   * Flights to a seat: a gather (in, whirl, out; from polar r0/a0 around the sun,
   * whirling at `swirl` px) or a plain glide from (x, y) when a seat changes.
   */
  private readonly flights = new Map<
    number,
    { at: number; x: number; y: number; r0: number; a0: number; swirl: number; traced: number } & (
      | { gather: true }
      | { gather: false; ms: number }
    )
  >();
  /**
   * The release playing: when it started (local time), its seed, where everyone
   * goes (our fresh view: who is around our spot; null until it arrives) and who
   * has already left their seat. The orbit lasts until everyone has.
   */
  private release: { at: number; seed: number; homes: Map<number, PlayerState> | null; gone: Set<number> } | null =
    null;
  /** When the sun flares as everyone bursts out to their seats (local time). */
  private flareAt = 0;
  /**
   * 0: the camera follows us; 1: it looks at the sun with every ring in view, as
   * the host sees it. Everyone gets that view while in orbit: following ourselves
   * round the sun spun the view and could leave the host off a phone's screen.
   */
  private overview = 0;
  private overviewTarget = 0;
  /** Zoom (wheel, pinch) in orbit, relative to fitting every ring on screen. */
  private orbitZoom = 1;
  private lastFrame = 0;
  /** Names over players in orbit: hidden unless the viewer turned them on in Settings. */
  private orbitNames = false;
  private gatherStyle: GatherStyle = "corona";
  private readonly corona = new CoronaEffect();
  private readonly burstTrails = new BurstTrails();
  private readonly teleports = new TeleportFx();
  /** What the frames being recorded are for (GatherStats). */
  private statsLabel: GatherStyle | "release" = "corona";
  /** The part of the world on screen last frame, with a margin (effects off screen are skipped). */
  private onScreen = { x0: 0, y0: 0, x1: 0, y1: 0 };
  /** Corona gather: when it started (local time); players fade in by ring after it. */
  private coronaAt = -1;
  /** Frame times of the gather playing now, for GatherStats. */
  private gatherFrames: number[] | null = null;
  /** Screen-space layer for names and chat bubbles. */
  private readonly overlay = new Container();
  private readonly avatars = new Map<number, Avatar>();
  private readonly keyboard = new KeyboardInput();
  private touch: TouchStick | null = null;
  private zoom: number;
  private selfId = -1;
  private tapTarget: { x: number; y: number } | null = null;
  private lastSent = { x: NaN, y: NaN, dir: "south" as Direction, moving: false };
  private lastSentAt = 0;

  private constructor(app: Application, callbacks: GameCallbacks) {
    this.app = app;
    this.callbacks = callbacks;
    // Phones start a little further out.
    this.zoom = Math.min(window.innerWidth, window.innerHeight) < 700 ? 0.6 : 0.9;
  }

  static async create(stage: HTMLElement, callbacks: GameCallbacks): Promise<Game> {
    const app = new Application();
    await app.init({
      resizeTo: window,
      background: "#04050c",
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    stage.appendChild(app.canvas);

    const game = new Game(app, callbacks);
    game.world.addChild(
      game.scene.backdrop,
      game.pollZones.view,
      game.trails,
      game.burstTrails.view,
      game.bodies,
      game.teleports.view,
      game.corona.view,
    );
    app.stage.addChild(game.scene.sky, game.world, game.overlay, game.minimap.view);
    game.setupPointer();
    game.setupZoom();
    game.touch = new TouchStick(app.canvas, () => !game.selfIsHost && !game.orbiting, (factor) => game.zoomBy(factor));
    game.minimap.layout(app.screen.width, app.screen.height);
    app.renderer.on("resize", (w: number, h: number) => game.minimap.layout(w, h));
    app.ticker.add((ticker) => game.update(ticker.deltaMS));
    if (new URLSearchParams(location.search).has("debug")) Object.assign(window, { game });
    return game;
  }

  get self(): Avatar | undefined {
    return this.avatars.get(this.selfId);
  }

  setSelf(id: number): void {
    this.selfId = id;
  }

  get selfIsHost(): boolean {
    return this.self?.role === "host";
  }

  addPlayer(info: PlayerInfo): void {
    this.avatars.get(info.id)?.destroy();
    const avatar = new Avatar(info, this.clock.latest, this.trails, this.bodies, this.overlay, info.id === this.selfId);
    avatar.setHand(info.hand > 0);
    this.avatars.set(info.id, avatar);
    if (info.id === this.selfId && info.role === "host") this.becameHost();
  }

  setRole(id: number, role: Role): void {
    const avatar = this.avatars.get(id);
    if (!avatar || avatar.role === role) return;
    avatar.setRole(role);
    if (id === this.selfId && role === "host") this.becameHost();
  }

  private becameHost(): void {
    this.tapTarget = null;
    this.zoom = Math.min(this.zoom, HOST_ZOOM);
  }

  /** The player drawn nearest to a screen point, within PICK_RADIUS; the host (the sun) excluded. */
  private playerAt(sx: number, sy: number): Avatar | null {
    let best: Avatar | null = null;
    let bestD = PICK_RADIUS;
    for (const a of this.avatars.values()) {
      if (a.role === "host" || a.id === this.selfId || this.visibility(a) < 0.3) continue;
      const d = Math.hypot(this.world.x + a.x * this.world.scale.x - sx, this.world.y + a.y * this.world.scale.x - sy);
      if (d < bestD) {
        best = a;
        bestD = d;
      }
    }
    return best;
  }

  /** A player reacted: float the emoji up if we can see them. */
  react(id: number, kind: number): void {
    const a = this.avatars.get(id);
    if (a && (a.role === "host" || this.visibility(a) > 0.1)) a.react(kind);
  }

  setHand(id: number, raised: boolean): void {
    this.avatars.get(id)?.setHand(raised);
  }

  showPoll(poll: Poll): void {
    if (poll.open) this.pollZones.show(poll);
    else this.pollZones.end(poll);
  }

  setPollCounts(counts: number[]): void {
    this.pollZones.setCounts(counts);
  }

  /** The answer planet we are in while a poll is open, or -1. */
  get pollAnswer(): number {
    const self = this.self;
    return self ? this.pollZones.zoneAt(self.x, self.y) : -1;
  }

  removePlayer(id: number): void {
    this.avatars.get(id)?.destroy();
    this.avatars.delete(id);
  }

  /** Forget every avatar, e.g. before a fresh "welcome" after reconnecting (maybe to another server). */
  resetPlayers(): void {
    for (const avatar of this.avatars.values()) avatar.destroy();
    this.avatars.clear();
    this.clock.reset();
    this.orbit = null;
    this.flights.clear();
    this.corona.stop();
    this.coronaAt = -1;
    this.burstTrails.begin();
    this.burstTrails.end();
    this.overview = this.overviewTarget = 0;
    this.release = null;
    this.teleports.clear();
  }

  /** In orbit (we cannot steer): until our own teleport home when released. */
  get orbiting(): boolean {
    return this.orbit !== null && !this.release?.gone.has(this.selfId);
  }

  /**
   * The host gathered everyone (or we joined while gathered: `animate` false).
   * Every player flies from where it is to its seat, leaving a trail of light, and
   * from then on follows its orbit; nobody steers.
   */
  startOrbit(state: OrbitState, animate: boolean): void {
    const serverNow = this.clock.observe(state.now, performance.now());
    // The start is modulo 2^32 too; how long ago it was is what counts.
    const start = serverNow - ((state.now - state.start) >>> 0);
    this.orbit = { start, slots: new Map(state.slots.map((s) => [s.id, s.slot])) };
    this.release = null;
    this.tapTarget = null;
    this.flights.clear();
    this.corona.stop();
    this.coronaAt = -1;
    this.overviewTarget = 1;
    this.orbitZoom = 1;
    if (!animate) {
      // Seated straight away (we joined mid-orbit): no trail from where they were.
      this.overview = 1;
      for (const id of this.orbit.slots.keys()) this.avatars.get(id)?.clearTrail();
      return;
    }
    const now = performance.now();
    this.gatherFrames = [];
    this.statsLabel = this.gatherStyle;
    if (this.gatherStyle === "corona") {
      // Everyone is in their seat already, hidden; the corona plays and they appear.
      this.coronaAt = now;
      this.corona.play(now, this.orbitExtent());
      // A flash at the bang, and the big one when everyone bursts out.
      this.flareAt = now + CORONA_BURST_AT;
      return;
    }
    for (const [id] of this.orbit.slots) {
      const a = this.avatars.get(id);
      if (!a) continue;
      const dx = a.x - WORLD_CENTER.x;
      const dy = a.y - WORLD_CENTER.y;
      this.flights.set(id, {
        gather: true,
        at: now + Math.random() * GATHER_JITTER_MS,
        x: a.x,
        y: a.y,
        r0: Math.hypot(dx, dy),
        a0: Math.atan2(dy, dx),
        swirl: SWIRL_RADIUS + Math.random() * SWIRL_THICKNESS,
        traced: 0,
      });
      a.setStreak(true);
    }
    this.flareAt = now + GATHER_IN_MS + GATHER_SWIRL_MS;
  }

  /** How this viewer's gathers look (Settings). */
  setGatherStyle(style: GatherStyle): void {
    this.gatherStyle = style;
  }

  /** The gather finished: report how smoothly it played. */
  private endGatherStats(): void {
    const frames = this.gatherFrames;
    this.gatherFrames = null;
    if (!frames || frames.length < 5) return;
    const sorted = [...frames].sort((a, b) => a - b);
    const total = frames.reduce((a, b) => a + b, 0);
    const stats: GatherStats = {
      style: this.statsLabel,
      players: this.avatars.size,
      frames: frames.length,
      avgFps: Math.round((1000 * frames.length) / total),
      p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
      worstFrameMs: Math.round(sorted.at(-1)!),
    };
    const list = ((window as unknown as { daystarGatherStats?: GatherStats[] }).daystarGatherStats ??= []);
    list.push(stats);
    console.info(
      `[gather] ${stats.style}, ${stats.players} players: ${stats.avgFps} fps avg, p95 ${stats.p95FrameMs} ms, worst ${stats.worstFrameMs} ms`,
    );
  }

  /** Settings: names over players in orbit. */
  setOrbitNames(shown: boolean): void {
    this.orbitNames = shown;
  }

  /** A seat given (or taken) mid-orbit: the player glides to it. */
  setSlot(id: number, slot: number): void {
    if (!this.orbit) return;
    const a = this.avatars.get(id);
    if (slot === 0xffff) this.orbit.slots.delete(id);
    else this.orbit.slots.set(id, slot);
    if (a && this.orbit.slots.has(id)) {
      this.flights.set(id, { gather: false, ms: RESEAT_MS, at: performance.now(), x: a.x, y: a.y, r0: 0, a0: 0, swirl: 0, traced: 0 });
    }
  }

  /**
   * The host let everyone go: they go back to where they were before the gather.
   * The teleports play in the order the server's seed gives; where each lands
   * comes in our fresh view (applyView), just after this.
   */
  releaseOrbit(state: OrbitState & { seed: number }): void {
    if (!this.orbit || this.release) return;
    this.clock.observe(state.now, performance.now());
    this.flights.clear();
    this.corona.stop();
    this.coronaAt = -1;
    this.burstTrails.begin();
    this.burstTrails.end();
    for (const a of this.avatars.values()) {
      a.setStreak(false);
      a.setReveal(1);
    }
    this.release = { at: performance.now(), seed: state.seed, homes: null, gone: new Set() };
    this.gatherFrames = [];
    this.statsLabel = "release";
  }

  private visible(x: number, y: number): boolean {
    const v = this.onScreen;
    return x >= v.x0 && x <= v.x1 && y >= v.y0 && y <= v.y1;
  }

  /** When seat `slot` teleports away, after the release started: a hash of the seat and the seed. */
  private releaseDelay(slot: number, seed: number): number {
    let h = Math.imul(slot + 1, 0x9e3779b1) ^ seed;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return ((h >>> 0) / 0x1_0000_0000) * RELEASE_SPREAD_MS;
  }

  /**
   * Release, for one seated player: still in its seat (fading out), or gone home
   * (fading in there if it is around us, out of view otherwise). Returns true once
   * it has left its seat.
   */
  private releasePlayer(id: number, slot: number, a: Avatar, now: number): boolean {
    const release = this.release!;
    const t = now - release.at - this.releaseDelay(slot, release.seed);
    if (!release.gone.has(id)) {
      const waited = now - release.at > RELEASE_GIVE_UP_MS;
      if (t < RELEASE_FADE_OUT_MS || (!release.homes && !waited)) {
        a.setReveal(1 - Math.min(1, Math.max(0, t) / RELEASE_FADE_OUT_MS));
        return false;
      }
      release.gone.add(id);
      a.setNameVisible(true);
      const color = appearanceOf(a.appearance).color;
      // A flash where it vanishes from its seat...
      if (this.visible(a.x, a.y)) this.teleports.spawn(a.x, a.y, color, true, now);
      const home = release.homes?.get(id);
      if (!home) {
        a.inView = false;
        a.setReveal(1);
        return true;
      }
      if (id === this.selfId) {
        a.x = home.x;
        a.y = home.y;
        a.setMotion(home.dir, false);
        a.clearTrail();
        // The server has us exactly here; the next move starts from it.
        this.lastSent = { x: home.x, y: home.y, dir: home.dir, moving: false };
        this.lastSentAt = now;
        this.overviewTarget = 0;
      } else {
        a.teleport(this.clock.latest, { ...home, moving: false });
      }
      a.inView = true;
      // ...and one where it appears.
      if (this.visible(home.x, home.y)) this.teleports.spawn(home.x, home.y, color, false, now);
    }
    const home = release.homes?.get(id);
    if (home) {
      a.x = home.x;
      a.y = home.y;
      a.setReveal(Math.min(1, Math.max(0, (t - RELEASE_FADE_OUT_MS) / RELEASE_FADE_IN_MS)));
    }
    return true;
  }

  /** Everyone has gone home: back to the normal room. */
  private finishRelease(): void {
    this.orbit = null;
    this.release = null;
    this.endGatherStats();
    this.overviewTarget = 0;
    for (const a of this.avatars.values()) {
      a.setNameVisible(true);
      a.setReveal(1);
    }
  }

  /** Orbit mode: put everyone with a seat where its orbit (or its flight to it) has it now. */
  private placeInOrbit(now: number): void {
    const orbit = this.orbit!;
    const serverNow = this.clock.serverNow(now);
    if (Number.isNaN(serverNow)) return;
    const seconds = (serverNow - orbit.start) / 1000;
    // Corona: hidden until the burst, then shooting out from beside the sun.
    const sinceCorona = this.coronaAt >= 0 ? now - this.coronaAt : Infinity;
    const extent = this.coronaAt >= 0 ? this.orbitExtent() : 1;
    const burning: { path: { x: number; y: number }[]; alpha: number; d: number }[] = [];
    const zoom = this.world.scale.x;
    const viewX = (this.app.screen.width / 2 - this.world.x) / zoom;
    const viewY = (this.app.screen.height / 2 - this.world.y) / zoom;
    let seated = 0;
    for (const [id, slot] of orbit.slots) {
      const a = this.avatars.get(id);
      if (!a) continue;
      if (this.release && this.releasePlayer(id, slot, a, now)) continue;
      seated++;
      const seat = orbitPosition(slot, seconds);
      let { x, y } = seat;
      if (sinceCorona < CORONA_BURST_AT + CORONA_OUT_STAGGER_MS + CORONA_OUT_MS) {
        const p = this.coronaPath(id, seat, sinceCorona, extent);
        ({ x, y } = p);
        // Visible as soon as it leaves the sun.
        a.setReveal(Math.min(1, p.k * 6));
        if (p.k > 0 && p.k < 1) {
          // Its trail: the same path a little earlier, head first.
          const path = [];
          for (let i = 0; i <= BURST_TRAIL_POINTS; i++) {
            path.push(this.coronaPath(id, seat, sinceCorona - (i / BURST_TRAIL_POINTS) * BURST_TRAIL_MS, extent));
          }
          burning.push({ path, alpha: Math.sqrt(1 - p.k), d: (x - viewX) ** 2 + (y - viewY) ** 2 });
        }
      } else {
        a.setReveal(1);
      }
      const flight = this.flights.get(id);
      if (flight) {
        const t = now - flight.at;
        const done = flight.gather ? t >= GATHER_IN_MS + GATHER_SWIRL_MS + GATHER_OUT_MS : t >= flight.ms;
        if (done) {
          this.flights.delete(id);
          a.setStreak(false);
        } else if (flight.gather) {
          ({ x, y } = this.gatherPosition(flight, Math.max(0, t), seat));
          // The light trail follows the true curve between frames.
          for (; flight.traced <= t; flight.traced += GATHER_TRAIL_STEP_MS) {
            const p = this.gatherPosition(flight, flight.traced, seat);
            a.addTrailPoint(p.x, p.y);
          }
        } else {
          const e = easeOut(t / flight.ms);
          x = flight.x + (x - flight.x) * e;
          y = flight.y + (y - flight.y) * e;
        }
      }
      a.x = x;
      a.y = y;
      a.setMotion(seat.dir, true);
      a.inView = true;
      a.setNameVisible(this.orbitNames);
    }
    // White-hot trails for the burst, the nearest to the middle if there are too many.
    if (burning.length > MAX_BURST_TRAILS) burning.sort((p, q) => p.d - q.d);
    this.burstTrails.begin();
    for (const b of burning) this.burstTrails.add(b.path, BURST_TRAIL_PX / zoom, b.alpha);
    this.burstTrails.end();
    const coronaDone =
      this.coronaAt < 0 || sinceCorona >= Math.max(CORONA_MS_TOTAL, CORONA_BURST_AT + CORONA_OUT_STAGGER_MS + CORONA_OUT_MS);
    if (coronaDone) this.coronaAt = -1;
    if (this.gatherFrames && this.flights.size === 0 && coronaDone) this.endGatherStats();
    if (this.release && seated === 0 && now - this.release.at > RELEASE_SPREAD_MS + RELEASE_FADE_OUT_MS + RELEASE_FADE_IN_MS) {
      this.finishRelease();
    }
  }

  /**
   * Where a gathering player is `t` ms into its flight, in polar coordinates
   * around the sun so every path is an arc: a spiral in that speeds up, a whirl,
   * then a spiral out that slows into its seat (`seat`, which keeps moving).
   */
  private gatherPosition(
    f: { r0: number; a0: number; swirl: number },
    t: number,
    seat: { x: number; y: number },
  ): { x: number; y: number } {
    let r: number;
    let a: number;
    // Turned through while spiralling in: it reaches the whirl at the whirl's speed.
    const inTurn = 0.5 * SWIRL_SPEED * GATHER_IN_MS;
    if (t < GATHER_IN_MS) {
      const k = t / GATHER_IN_MS;
      r = f.r0 + (f.swirl - f.r0) * k * k;
      a = f.a0 + inTurn * k * k;
    } else if (t < GATHER_IN_MS + GATHER_SWIRL_MS) {
      r = f.swirl;
      a = f.a0 + inTurn + SWIRL_SPEED * (t - GATHER_IN_MS);
    } else {
      const k = (t - GATHER_IN_MS - GATHER_SWIRL_MS) / GATHER_OUT_MS;
      const e = easeOut(k);
      const whirl = f.a0 + inTurn + SWIRL_SPEED * (t - GATHER_IN_MS);
      // The seat's angle, taken ahead of where the whirl ends so nobody turns back.
      const whirlEnd = f.a0 + inTurn + SWIRL_SPEED * (GATHER_SWIRL_MS + GATHER_OUT_MS);
      let seatAngle = Math.atan2(seat.y - WORLD_CENTER.y, seat.x - WORLD_CENTER.x);
      seatAngle += TAU * Math.ceil((whirlEnd - seatAngle) / TAU);
      r = f.swirl + (Math.hypot(seat.x - WORLD_CENTER.x, seat.y - WORLD_CENTER.y) - f.swirl) * e;
      a = whirl + (seatAngle - whirl) * e;
    }
    return { x: WORLD_CENTER.x + Math.cos(a) * r, y: WORLD_CENTER.y + Math.sin(a) * r };
  }

  /** Give the trail budget to the moving players nearest the middle of the screen (always us). */
  private shareTrails(width: number, height: number): void {
    const zoom = this.world.scale.x;
    const cx = (width / 2 - this.world.x) / zoom;
    const cy = (height / 2 - this.world.y) / zoom;
    const wanting: { a: Avatar; d: number }[] = [];
    for (const a of this.avatars.values()) {
      a.trailAllowed = false;
      if (a.wantsTrail) wanting.push({ a, d: a.id === this.selfId ? -1 : (a.x - cx) ** 2 + (a.y - cy) ** 2 });
    }
    if (wanting.length > TRAIL_BUDGET) wanting.sort((p, q) => p.d - q.d);
    for (let i = 0; i < Math.min(TRAIL_BUDGET, wanting.length); i++) wanting[i].a.trailAllowed = true;
  }

  /**
   * Corona: where a player is `t` ms after the bang. Hidden beside the sun until
   * the burst, then out along a spiral, turning the way the streams turn, and
   * slowing into its seat (`seat`, which keeps moving), like the fly-in's end.
   */
  private coronaPath(
    id: number,
    seat: { x: number; y: number },
    t: number,
    extent: number,
  ): { x: number; y: number; k: number } {
    const seatR = Math.hypot(seat.x - WORLD_CENTER.x, seat.y - WORLD_CENTER.y);
    const leave = CORONA_BURST_AT + (seatR / extent) * CORONA_OUT_STAGGER_MS;
    const k = Math.min(1, Math.max(0, (t - leave) / CORONA_OUT_MS));
    const e = easeOut(k);
    // A steady per-player start just outside the sun, and how far round it travels.
    const h = ((id * 2654435761) >>> 0) / 0x1_0000_0000;
    const startR = SWIRL_RADIUS + h * SWIRL_THICKNESS;
    const seatAngle = Math.atan2(seat.y - WORLD_CENTER.y, seat.x - WORLD_CENTER.x);
    const angle = seatAngle - (1 - e) * (1 + h * 0.8);
    const r = startR + (seatR - startR) * e;
    return { x: WORLD_CENTER.x + Math.cos(angle) * r, y: WORLD_CENTER.y + Math.sin(angle) * r, k };
  }

  /** Radius that holds every seat in use, for the camera's overview. */
  private orbitExtent(): number {
    let seats = 0;
    for (const slot of this.orbit?.slots.values() ?? []) seats = Math.max(seats, slot - STAGE_SLOTS + 1);
    // Rings hold about 2πr / SEAT_SPACING seats each; enough to find the outermost one.
    let r = FIRST_RING;
    while (seats > 0) {
      seats -= Math.floor((TAU * r) / SEAT_SPACING);
      if (seats > 0) r += RING_GAP;
    }
    return r + 120;
  }

  /** Snapshots now come `hz` times a second. */
  setSnapshotRate(hz: number): void {
    this.clock.intervalMs = 1000 / hz;
    // Three intervals without a position means the player stood still.
    Track.idleGapMs = 3000 / hz;
  }

  /** A snapshot taken at server time `time`; each position is `age` ms older than that. */
  applySnapshot(players: SnapshotPlayer[], time: number): void {
    const serverTime = this.clock.observe(time, performance.now());
    for (const p of players) this.place(p, serverTime - p.age);
  }

  private place(p: PlayerState, t: number): void {
    if (p.id === this.selfId) return;
    const avatar = this.avatars.get(p.id);
    if (!avatar) return;
    // Back in view after a while: appear where it is, do not slide from where it was.
    if (avatar.inView) avatar.pushSample(t, p);
    else avatar.teleport(t, p);
    avatar.inView = true;
  }

  /**
   * Area of interest: our view moved from cell `from` to `to`; `players` is
   * everyone in the part that just came into view. Anyone else we last saw there
   * has gone (we were not told while it was out of view).
   */
  applyView(from: number, to: number, players: PlayerState[]): void {
    if (from === FRESH_VIEW) {
      const homes = new Map(players.map((p) => [p.id, p]));
      // During a release the teleports place everyone when their turn comes.
      if (this.release) this.release.homes = homes;
      else this.applyFreshView(homes);
      return;
    }
    const listed = new Set(players.map((p) => p.id));
    for (const a of this.avatars.values()) {
      if (a.id === this.selfId || a.role !== "guest" || listed.has(a.id)) continue;
      if (inView(a.x, a.y, to) && !inView(a.x, a.y, from)) a.inView = false;
    }
    // A view carries no time; it follows the newest snapshot.
    for (const p of players) this.place(p, this.clock.latest);
  }

  /** A whole new view: those listed are where it says; other guests are out of view. */
  private applyFreshView(homes: Map<number, PlayerState>): void {
    for (const a of this.avatars.values()) {
      if (a.id === this.selfId || a.role !== "guest" || homes.has(a.id)) continue;
      a.inView = false;
    }
    for (const p of homes.values()) {
      if (p.id === this.selfId) continue;
      this.avatars.get(p.id)?.teleport(this.clock.latest, p);
      const a = this.avatars.get(p.id);
      if (a) a.inView = true;
    }
  }

  /**
   * How visible a player is: the host, speakers and we are always fully visible;
   * others fade out with distance (fog) and vanish when the server left them out,
   * except in orbit, where everyone is.
   */
  private visibility(a: Avatar): number {
    const self = this.self;
    if (!self || a === self || a.role !== "guest") return 1;
    // In orbit everyone's place is known (their seat), so everyone shows, as
    // the host sees it; the area-of-interest fog would hide the far side of the rings.
    if (this.orbit?.slots.has(a.id) && !this.release?.gone.has(a.id)) return 1;
    if (!a.inView) return 0;
    return fogAt(Math.hypot(a.x - self.x, a.y - self.y));
  }

  /** The server rejected our last position; snap back to its authoritative one. */
  applyCorrection(x: number, y: number): void {
    const self = this.self;
    if (!self) return;
    self.x = x;
    self.y = y;
    this.tapTarget = null;
  }

  showChat(playerId: number, text: string): void {
    this.avatars.get(playerId)?.showBubble(text);
  }

  private setupPointer(): void {
    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = new Rectangle(0, 0, 1e6, 1e6);
    this.app.stage.on("pointertap", (e) => {
      (document.activeElement as HTMLElement | null)?.blur();
      if (this.touch?.wasGesture()) return; // a thumbstick drag or a pinch, not a tap
      if (this.selfIsHost) {
        // The host does not move; a tap picks a player instead.
        const picked = this.playerAt(e.global.x, e.global.y);
        if (picked) this.callbacks.pick(picked.id, e.global.x, e.global.y);
        return;
      }
      if (this.orbiting) return; // gathered: nobody steers
      this.tapTarget = {
        x: (e.global.x - this.world.x) / this.world.scale.x,
        y: (e.global.y - this.world.y) / this.world.scale.x,
      };
    });
  }

  /** Mouse wheel and +/- keys zoom around the player. */
  private zoomBy(factor: number): void {
    if (this.orbiting) this.orbitZoom = Math.min(8, Math.max(0.5, this.orbitZoom * factor));
    else this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
  }

  private setupZoom(): void {
    const zoomBy = (factor: number) => this.zoomBy(factor);
    this.app.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        zoomBy(Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
    window.addEventListener("keydown", (e) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      if (e.key === "+" || e.key === "=") zoomBy(1.2);
      else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.2);
    });
  }

  private update(deltaMs: number): void {
    const now = performance.now();
    this.gatherFrames?.push(deltaMs);
    {
      const zoom = this.world.scale.x;
      const margin = 200 / zoom;
      const { width, height } = this.app.screen;
      this.onScreen.x0 = -this.world.x / zoom - margin;
      this.onScreen.y0 = -this.world.y / zoom - margin;
      this.onScreen.x1 = (width - this.world.x) / zoom + margin;
      this.onScreen.y1 = (height - this.world.y) / zoom + margin;
    }
    this.updateSelf(Math.min(deltaMs, 100) / 1000, now);
    const renderTime = this.clock.renderTime(now);
    for (const avatar of this.avatars.values()) {
      if (avatar.id !== this.selfId && !this.orbit?.slots.has(avatar.id)) avatar.interpolate(renderTime);
    }
    if (this.orbit) this.placeInOrbit(now);
    this.corona.update(now, this.world.scale.x);
    this.teleports.update(now, this.world.scale.x);
    this.updateCamera();
    const { width, height } = this.app.screen;
    let hostLevel = 0;
    for (const avatar of this.avatars.values()) {
      if (avatar.role === "guest") continue;
      const level = this.callbacks.voiceLevel(avatar.id);
      if (avatar.role === "host") hostLevel = level;
      else avatar.setVoiceLevel(level);
    }
    // Everyone arriving makes the sun flare.
    const flare = Math.max(0, 1 - Math.abs(now - this.flareAt) / 600);
    this.scene.setHostVoiceLevel(Math.max(hostLevel, flare));
    this.scene.update(now, this.world.x, this.world.y, this.world.scale.x, width, height);
    if (this.self) this.pollZones.update(now, this.self.x, this.self.y);
    this.shareTrails(width, height);
    const seen = new Map<Avatar, number>();
    for (const avatar of this.avatars.values()) {
      const visibility = this.visibility(avatar);
      seen.set(avatar, visibility);
      avatar.render(now, this.world.x, this.world.y, this.world.scale.x, visibility);
    }
    this.minimap.update(
      now,
      // The host is the sun, already on the map; fogged players are not shown.
      [...seen].filter(([a, v]) => a.role !== "host" && v > 0).map(([a, v]) => ({
        x: a.x,
        y: a.y,
        color: appearanceOf(a.appearance).color,
        self: a.id === this.selfId,
        alpha: v,
      })),
      {
        x: -this.world.x / this.world.scale.x,
        y: -this.world.y / this.world.scale.x,
        w: width / this.world.scale.x,
        h: height / this.world.scale.x,
      },
    );
  }

  private updateSelf(dt: number, now: number): void {
    const self = this.self;
    if (!self || self.role === "host") return;
    if (this.orbiting && this.orbit?.slots.has(self.id)) return; // gathered: the orbit moves us

    let { x: vx, y: vy } = this.keyboard.vector();
    /** Share of full speed: the thumbstick walks slower near its center. */
    let throttle = 1;
    if (vx === 0 && vy === 0 && this.touch) {
      const stick = this.touch.vector();
      if (stick.x !== 0 || stick.y !== 0) {
        ({ x: vx, y: vy } = stick);
        throttle = Math.min(1, Math.hypot(vx, vy) / 0.6);
      }
    }
    if (vx !== 0 || vy !== 0) {
      this.tapTarget = null;
    } else if (this.tapTarget) {
      vx = this.tapTarget.x - self.x;
      vy = this.tapTarget.y - self.y;
      if (Math.hypot(vx, vy) <= ARRIVE_DISTANCE) {
        this.tapTarget = null;
        vx = vy = 0;
      }
    }

    let moving = false;
    let dir = self.dir;
    if (vx !== 0 || vy !== 0) {
      const len = Math.hypot(vx, vy);
      let step = MOVE_SPEED * dt * throttle;
      if (this.tapTarget) step = Math.min(step, len);
      let next = moveInSpace(self.x, self.y, (vx / len) * step, (vy / len) * step);
      // Snap to the wire grid so the server validates exactly this position.
      const snapped = { x: quantize(next.x), y: quantize(next.y) };
      next = canBeAt(snapped.x, snapped.y) ? snapped : self;
      moving = next.x !== self.x || next.y !== self.y;
      if (!moving) this.tapTarget = null; // pressed against the sun or the edge
      dir = facing(vx, vy, self.dir);
      self.x = next.x;
      self.y = next.y;
    }
    self.setMotion(dir, moving);

    const s = this.lastSent;
    const changed = s.x !== self.x || s.y !== self.y || s.dir !== dir || s.moving !== moving;
    // Stopping is sent immediately so others do not see us drifting on.
    if (changed && (now - this.lastSentAt >= SEND_INTERVAL_MS || (!moving && s.moving))) {
      this.callbacks.sendMove(self.x, self.y, dir, moving);
      this.lastSent = { x: self.x, y: self.y, dir, moving };
      this.lastSentAt = now;
    }
  }

  /** Keep the local player in the middle of the screen. */
  private updateCamera(): void {
    const self = this.self;
    const { width, height } = this.app.screen;
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 0;
    this.lastFrame = now;
    // During a gather the camera eases over the sun, zoomed out to see the whole show.
    const step = dt * CAMERA_EASE_PER_MS;
    this.overview += Math.max(-step, Math.min(step, this.overviewTarget - this.overview));
    const k = this.overview * this.overview * (3 - 2 * this.overview);
    const wide = (Math.min(width, height) / (2 * this.orbitExtent())) * this.orbitZoom;
    const zoom = this.zoom + (wide - this.zoom) * k;
    this.world.scale.set(zoom);
    if (!self) return;
    const cx = self.x + (WORLD_CENTER.x - self.x) * k;
    const cy = self.y + (WORLD_CENTER.y - self.y) * k;
    this.world.position.set(width / 2 - cx * zoom, height / 2 - cy * zoom);
  }
}
