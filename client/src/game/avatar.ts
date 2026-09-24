import { AnimatedSprite, Container, Graphics, Text, type Spritesheet } from "pixi.js";
import {
  CHARACTERS,
  animationName,
  type AnimationState,
  type CharacterId,
  type Direction,
} from "../../../shared/src/characters.ts";
import type { PlayerInfo } from "../../../shared/src/protocol.ts";

const BUBBLE_MS = 6000;
const BUBBLE_MAX_WIDTH = 200;
/** Remote players are drawn this far in the past so there are two samples to blend. */
export const INTERPOLATION_DELAY_MS = 100;

interface Sample {
  t: number;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
}

/**
 * One player on the map: the animated body lives in the zoomed world layer,
 * the name tag and chat bubble live in the unscaled overlay so text stays crisp.
 */
export class Avatar {
  readonly id: number;
  readonly name: string;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;

  private readonly sheet: Spritesheet;
  readonly character: CharacterId;
  private readonly body: AnimatedSprite;
  private readonly tag = new Container();
  private readonly label: Text;
  private bubble: Container | null = null;
  private bubbleUntil = 0;
  private readonly headHeight: number;
  private readonly samples: Sample[] = [];

  constructor(info: PlayerInfo, sheet: Spritesheet, world: Container, overlay: Container, isSelf: boolean) {
    this.id = info.id;
    this.name = info.name;
    this.x = info.x;
    this.y = info.y;
    this.dir = info.dir;
    this.moving = info.moving;
    this.sheet = sheet;
    this.character = info.character;

    const def = CHARACTERS[info.character];
    this.headHeight = (sheet.data.meta as unknown as { height: number }).height * def.scale;

    this.body = new AnimatedSprite(this.textures(this.state));
    this.body.scale.set(def.scale);
    this.body.animationSpeed = this.fps / 60;
    this.body.play();
    world.addChild(this.body);

    this.label = new Text({
      text: info.name,
      style: {
        fontFamily: "Pixelify Sans, system-ui, sans-serif",
        fontSize: 14,
        fill: isSelf ? 0xffe38a : 0xffffff,
        stroke: { color: 0x2a1a10, width: 4, join: "round" },
      },
    });
    this.label.anchor.set(0.5, 1);
    this.tag.addChild(this.label);
    overlay.addChild(this.tag);

    this.pushSample(performance.now(), info);
    this.render();
  }

  private get state(): AnimationState {
    return this.moving ? "run" : "idle";
  }

  private get fps(): number {
    const def = CHARACTERS[this.character];
    return this.moving ? def.runFps : def.idleFps;
  }

  private textures(state: AnimationState) {
    return this.sheet.animations[animationName(state, this.dir)];
  }

  /** Update facing/animation; only swaps textures when something changed. */
  setMotion(dir: Direction, moving: boolean): void {
    if (dir === this.dir && moving === this.moving) return;
    this.dir = dir;
    this.moving = moving;
    this.body.textures = this.textures(this.state);
    this.body.animationSpeed = this.fps / 60;
    this.body.play();
  }

  pushSample(t: number, s: { x: number; y: number; dir: Direction; moving: boolean }): void {
    this.samples.push({ t, x: s.x, y: s.y, dir: s.dir, moving: s.moving });
    if (this.samples.length > 30) this.samples.shift();
  }

  /** Blend buffered server samples for a remote player. */
  interpolate(now: number): void {
    const renderT = now - INTERPOLATION_DELAY_MS;
    const s = this.samples;
    while (s.length >= 2 && s[1].t <= renderT) s.shift();

    const a = s[0];
    const b = s[1];
    if (!b || renderT <= a.t) {
      this.x = a.x;
      this.y = a.y;
      this.setMotion(a.dir, a.moving);
      return;
    }
    const k = (renderT - a.t) / (b.t - a.t);
    this.x = a.x + (b.x - a.x) * k;
    this.y = a.y + (b.y - a.y) * k;
    this.setMotion(b.dir, b.moving);
  }

  showBubble(text: string): void {
    this.bubble?.destroy({ children: true });

    const content = new Text({
      text,
      style: {
        fontFamily: "Pixelify Sans, system-ui, sans-serif",
        fontSize: 14,
        fill: 0x3b2a1e,
        wordWrap: true,
        wordWrapWidth: BUBBLE_MAX_WIDTH,
        breakWords: true,
      },
    });
    const padX = 8;
    const padY = 5;
    const w = content.width + padX * 2;
    const h = content.height + padY * 2;
    const bg = new Graphics()
      .roundRect(-w / 2, -h - 6, w, h, 8)
      .fill(0xfdf8ea)
      .stroke({ color: 0x4c1e0a, width: 2 })
      .poly([-5, -7, 5, -7, 0, 0])
      .fill(0xfdf8ea);
    content.position.set(-w / 2 + padX, -h - 6 + padY);

    this.bubble = new Container();
    this.bubble.addChild(bg, content);
    this.bubble.y = -this.label.height - 2;
    this.tag.addChild(this.bubble);
    this.bubbleUntil = performance.now() + BUBBLE_MS;
  }

  /** Sync sprite and overlay with the current position; call once per frame after the camera moves. */
  render(worldX = 0, worldY = 0, zoom = 1): void {
    this.body.position.set(this.x, this.y);
    this.body.zIndex = this.y;
    this.tag.position.set(
      Math.round(worldX + this.x * zoom),
      Math.round(worldY + (this.y - this.headHeight) * zoom - 2),
    );
    this.tag.zIndex = this.y;

    if (this.bubble) {
      const left = this.bubbleUntil - performance.now();
      if (left <= 0) {
        this.bubble.destroy({ children: true });
        this.bubble = null;
      } else {
        this.bubble.alpha = Math.min(1, left / 400);
      }
    }
  }

  destroy(): void {
    this.body.destroy();
    this.tag.destroy({ children: true });
  }
}
