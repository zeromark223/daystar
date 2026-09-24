import { Application, Assets, Container, Graphics, Rectangle, Sprite, TextureStyle, type Spritesheet } from "pixi.js";
import { CHARACTER_IDS, collisionOffsetY, type CharacterId, type Direction } from "../../../shared/src/characters.ts";
import { BODY_RADIUS, CollisionMap } from "../../../shared/src/collision.ts";
import { MAP_HEIGHT, MAP_WIDTH, MOVE_SPEED, TICK_RATE } from "../../../shared/src/constants.ts";
import { quantize, type PlayerInfo, type PlayerState } from "../../../shared/src/protocol.ts";
import { Avatar } from "./avatar.ts";
import { CollisionOverlay } from "./collision-overlay.ts";
import { KeyboardInput } from "./input.ts";
import { MapEditor } from "./map-editor.ts";

export interface GameCallbacks {
  sendMove(x: number, y: number, dir: Direction, moving: boolean): void;
}

const SEND_INTERVAL_MS = 1000 / TICK_RATE;
const ARRIVE_DISTANCE = 2;

function pickZoom(width: number, height: number): number {
  return Math.max(1, Math.round(Math.min(width / 800, height / 500)));
}

/** Facing for a movement vector; keeps the current facing on exact diagonals so it does not flicker. */
function facing(vx: number, vy: number, current: Direction): Direction {
  const ax = Math.abs(vx);
  const ay = Math.abs(vy);
  if (ax > ay) return vx > 0 ? "east" : "west";
  if (ay > ax) return vy > 0 ? "south" : "north";
  const horizontal = vx > 0 ? "east" : "west";
  const vertical = vy > 0 ? "south" : "north";
  return current === horizontal || current === vertical ? current : vertical;
}

export class Game {
  private readonly app: Application;
  private readonly sheets: Record<CharacterId, Spritesheet>;
  private readonly map: CollisionMap;
  private readonly callbacks: GameCallbacks;
  private editor: MapEditor | null = null;
  /** Outline of the local player's collision circle, shown with ?debug / ?edit. */
  private bodyBox: Graphics | null = null;
  private readonly world = new Container({ sortableChildren: false });
  private readonly entities = new Container({ sortableChildren: true });
  private readonly overlay = new Container({ sortableChildren: true });
  private readonly avatars = new Map<number, Avatar>();
  private readonly keyboard = new KeyboardInput();
  private zoom = 1;
  private selfId = -1;
  private tapTarget: { x: number; y: number } | null = null;
  private lastSent = { x: NaN, y: NaN, dir: "south" as Direction, moving: false };
  private lastSentAt = 0;

  private constructor(
    app: Application,
    sheets: Record<CharacterId, Spritesheet>,
    map: CollisionMap,
    callbacks: GameCallbacks,
  ) {
    this.app = app;
    this.sheets = sheets;
    this.map = map;
    this.callbacks = callbacks;
  }

  static async create(stage: HTMLElement, callbacks: GameCallbacks): Promise<Game> {
    TextureStyle.defaultOptions.scaleMode = "nearest";

    const app = new Application();
    await app.init({
      resizeTo: window,
      background: "#2f2f33",
      antialias: false,
      roundPixels: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    stage.appendChild(app.canvas);

    const [collisionText, mapTexture, ...sheetList] = await Promise.all([
      fetch("/api/collision").then((r) => {
        if (!r.ok) throw new Error(`Could not load the collision map (HTTP ${r.status}).`);
        return r.text();
      }),
      Assets.load("/assets/map.png"),
      ...CHARACTER_IDS.map((id) => Assets.load<Spritesheet>(`/assets/characters/${id}.json`)),
    ]);
    const sheets = Object.fromEntries(CHARACTER_IDS.map((id, i) => [id, sheetList[i]])) as Record<
      CharacterId,
      Spritesheet
    >;

    const map = CollisionMap.parse(collisionText);
    const game = new Game(app, sheets, map, callbacks);
    game.world.addChild(new Sprite(mapTexture));
    app.stage.addChild(game.world, game.overlay);
    game.setupPointer();

    // ?debug shows collision cells; ?edit also adds the Draw / Erase toolbar.
    const params = new URLSearchParams(location.search);
    if (params.has("debug") || params.has("edit")) {
      const collisionOverlay = new CollisionOverlay(map);
      game.world.addChild(collisionOverlay.sprite);
      game.bodyBox = new Graphics()
        .circle(0, 0, BODY_RADIUS)
        .stroke({ color: 0xffe38a, width: 1 });
      if (params.has("edit")) game.editor = new MapEditor(map, collisionOverlay, game.world, app.stage);
      Object.assign(window, { game });
    }
    game.world.addChild(game.entities);
    if (game.bodyBox) game.world.addChild(game.bodyBox);
    game.resize();
    app.renderer.on("resize", () => game.resize());
    app.ticker.add((ticker) => game.update(ticker.deltaMS));
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
    this.avatars.set(
      info.id,
      new Avatar(info, this.sheets[info.character], this.entities, this.overlay, info.id === this.selfId),
    );
  }

  removePlayer(id: number): void {
    this.avatars.get(id)?.destroy();
    this.avatars.delete(id);
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
      if (this.editor?.active) return;
      (document.activeElement as HTMLElement | null)?.blur();
      this.tapTarget = {
        x: (e.global.x - this.world.x) / this.zoom,
        y: (e.global.y - this.world.y) / this.zoom,
      };
    });
  }

  private resize(): void {
    this.zoom = pickZoom(this.app.screen.width, this.app.screen.height);
    this.world.scale.set(this.zoom);
  }

  private update(deltaMs: number): void {
    const now = performance.now();
    this.updateSelf(Math.min(deltaMs, 100) / 1000, now);
    for (const avatar of this.avatars.values()) {
      if (avatar.id !== this.selfId) avatar.interpolate(now);
    }
    this.updateCamera();
    for (const avatar of this.avatars.values()) avatar.render(this.world.x, this.world.y, this.zoom);
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
      const offset = collisionOffsetY(self.character);
      let next = this.map.moveWithCollision(self.x, self.y, (vx / len) * step, (vy / len) * step, offset);
      // Snap to the wire grid so the server validates exactly this position.
      const snapped = { x: quantize(next.x), y: quantize(next.y) };
      next = this.map.canStandAt(snapped.x, snapped.y, offset) ? snapped : self;
      moving = next.x !== self.x || next.y !== self.y;
      if (!moving) this.tapTarget = null; // walked into a wall
      dir = facing(vx, vy, self.dir);
      self.x = next.x;
      self.y = next.y;
    }
    self.setMotion(dir, moving);
    this.bodyBox?.position.set(self.x, self.y - collisionOffsetY(self.character));

    const s = this.lastSent;
    const changed = s.x !== self.x || s.y !== self.y || s.dir !== dir || s.moving !== moving;
    // Stopping is sent immediately so others do not see us running in place.
    if (changed && (now - this.lastSentAt >= SEND_INTERVAL_MS || (!moving && s.moving))) {
      this.callbacks.sendMove(self.x, self.y, dir, moving);
      this.lastSent = { x: self.x, y: self.y, dir, moving };
      this.lastSentAt = now;
    }
  }

  private updateCamera(): void {
    const self = this.self;
    if (!self) return;
    const { width, height } = this.app.screen;
    const mapW = MAP_WIDTH * this.zoom;
    const mapH = MAP_HEIGHT * this.zoom;
    const cx = mapW > width ? clamp(width / 2 - self.x * this.zoom, width - mapW, 0) : (width - mapW) / 2;
    const cy = mapH > height ? clamp(height / 2 - self.y * this.zoom, height - mapH, 0) : (height - mapH) / 2;
    this.world.position.set(Math.round(cx), Math.round(cy));
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
