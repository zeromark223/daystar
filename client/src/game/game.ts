import { Application, Container, Rectangle } from "pixi.js";
import { appearanceOf } from "../../../shared/src/appearance.ts";
import { MOVE_SPEED, TICK_RATE } from "../../../shared/src/constants.ts";
import { facing, type Direction } from "../../../shared/src/direction.ts";
import { quantize, type PlayerInfo, type PlayerState } from "../../../shared/src/protocol.ts";
import { canBeAt, moveInSpace } from "../../../shared/src/space.ts";
import { Avatar } from "./avatar.ts";
import { KeyboardInput } from "./input.ts";
import { Minimap } from "./minimap.ts";
import { SpaceScene } from "./space-scene.ts";

export interface GameCallbacks {
  sendMove(x: number, y: number, dir: Direction, moving: boolean): void;
}

const SEND_INTERVAL_MS = 1000 / TICK_RATE;
const ARRIVE_DISTANCE = 3;
const MIN_ZOOM = 0.12;
const MAX_ZOOM = 2.5;

export class Game {
  private readonly app: Application;
  private readonly callbacks: GameCallbacks;
  private readonly scene = new SpaceScene();
  private readonly minimap = new Minimap();
  /** The world, scaled by the zoom: backdrop, trails, bodies. */
  private readonly world = new Container();
  private readonly trails = new Container();
  private readonly bodies = new Container();
  /** Screen-space layer for names and chat bubbles. */
  private readonly overlay = new Container();
  private readonly avatars = new Map<number, Avatar>();
  private readonly keyboard = new KeyboardInput();
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
    game.world.addChild(game.scene.backdrop, game.trails, game.bodies);
    app.stage.addChild(game.scene.sky, game.world, game.overlay, game.minimap.view);
    game.setupPointer();
    game.setupZoom();
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

  addPlayer(info: PlayerInfo): void {
    this.avatars.get(info.id)?.destroy();
    this.avatars.set(info.id, new Avatar(info, this.trails, this.bodies, this.overlay, info.id === this.selfId));
  }

  removePlayer(id: number): void {
    this.avatars.get(id)?.destroy();
    this.avatars.delete(id);
  }

  /** Forget every avatar, e.g. before a fresh "welcome" after reconnecting. */
  resetPlayers(): void {
    for (const avatar of this.avatars.values()) avatar.destroy();
    this.avatars.clear();
  }

  applySnapshot(players: PlayerState[]): void {
    const now = performance.now();
    for (const p of players) {
      if (p.id === this.selfId) continue;
      this.avatars.get(p.id)?.pushSample(now, p);
    }
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
      this.tapTarget = {
        x: (e.global.x - this.world.x) / this.zoom,
        y: (e.global.y - this.world.y) / this.zoom,
      };
    });
  }

  /** Mouse wheel and +/- keys zoom around the player. */
  private setupZoom(): void {
    const zoomBy = (factor: number) => {
      this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    };
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
    this.updateSelf(Math.min(deltaMs, 100) / 1000, now);
    for (const avatar of this.avatars.values()) {
      if (avatar.id !== this.selfId) avatar.interpolate(now);
    }
    this.updateCamera();
    const { width, height } = this.app.screen;
    this.scene.update(now, this.world.x, this.world.y, this.zoom, width, height);
    for (const avatar of this.avatars.values()) avatar.render(now, this.world.x, this.world.y, this.zoom);
    this.minimap.update(
      now,
      [...this.avatars.values()].map((a) => ({
        x: a.x,
        y: a.y,
        color: appearanceOf(a.appearance).color,
        self: a.id === this.selfId,
      })),
      { x: -this.world.x / this.zoom, y: -this.world.y / this.zoom, w: width / this.zoom, h: height / this.zoom },
    );
  }

  private updateSelf(dt: number, now: number): void {
    const self = this.self;
    if (!self) return;

    let { x: vx, y: vy } = this.keyboard.vector();
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
      let step = MOVE_SPEED * dt;
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
    this.world.scale.set(this.zoom);
    if (!self) return;
    this.world.position.set(width / 2 - self.x * this.zoom, height / 2 - self.y * this.zoom);
  }
}
