import { Container, Graphics, Sprite, Text } from "pixi.js";
import { appearanceOf, type AppearanceId, type BodyKind } from "../../../shared/src/appearance.ts";
import { SUN_RADIUS, WORLD_CENTER } from "../../../shared/src/constants.ts";
import type { Direction } from "../../../shared/src/direction.ts";
import type { PlayerInfo } from "../../../shared/src/protocol.ts";
import { ROLE_LABELS, type Role } from "../../../shared/src/roles.ts";
import { brightnessAt } from "../../../shared/src/space.ts";
import { BodyView, SIZES } from "./bodies.ts";
import { Track } from "./timeline.ts";
import { REACTIONS } from "../../../shared/src/audience.ts";
import { emojiTexture, glowTexture } from "./textures.ts";

const BUBBLE_MS = 6000;
const BUBBLE_MAX_WIDTH = 220;

/** Trail: positions kept while moving, and how often one is recorded. */
const TRAIL_POINTS = 14;
const TRAIL_EVERY_MS = 45;
/** Bodies never shrink below this share of their size when the camera zooms out. */
const MIN_SCREEN_SCALE = 0.55;
const ROLE_COLOR = 0xffd166;
/** A reaction floats up this far (screen px) and fades out over REACTION_MS. */
const REACTION_RISE = 70;
const REACTION_MS = 1600;
const REACTION_SIZE = 28;
/** Per player and in total, so a room-wide burst of applause stays cheap to draw. */
const MAX_REACTIONS_PER_AVATAR = 4;
const MAX_LIVE_REACTIONS = 80;
let liveReactions = 0;


/**
 * One player: a glowing body (and its trail) in the world layer; the name tag
 * and chat bubble live in the unscaled overlay so text stays crisp. The host has
 * no body of its own: it is the sun, and its tag sits on top of it.
 */
export class Avatar {
  readonly id: number;
  readonly name: string;
  readonly appearance: AppearanceId;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
  role: Role;

  private readonly isSelf: boolean;
  private readonly color: number;
  private readonly kind: BodyKind;
  private readonly body = new Container();
  private readonly core: BodyView;
  /** Last drawn position and the velocity it implies (world px/s), for faces and tails. */
  private lastDrawn = { x: 0, y: 0, t: 0 };
  private velocity = { vx: 0, vy: 0 };
  private readonly trail = new Graphics();
  private readonly trailPoints: { x: number; y: number }[] = [];
  private lastTrailAt = 0;
  /** Only for the local player: a faint marker once it has faded near the edge. */
  private readonly marker: Graphics | null = null;
  /** Speakers wear a ring that swells while they talk. */
  private readonly ring: Graphics;
  /** How loud this player is talking, 0..1, set every frame. */
  private voiceLevel = 0;
  private readonly tag = new Container();
  private readonly floating = new Container();
  private readonly reactions: { sprite: Sprite; born: number; drift: number }[] = [];
  /** A reaction makes the face open its mouth for a moment. */
  private reactedUntil = 0;
  private handIcon: Sprite | null = null;
  private readonly label: Text;
  private readonly roleTag: Text;
  private bubble: Container | null = null;
  private bubbleUntil = 0;
  /** Positions on the server's timeline (remote players only). */
  private readonly track = new Track();
  /**
   * Area of interest: whether our knowledge of this player is current. False once
   * the server's "view" left it out (its last position may be stale); it comes
   * back with the next snapshot or view that has it.
   */
  inView = true;

  /** `serverTime`: the server time `info` was true at (the newest one we know). */
  constructor(info: PlayerInfo, serverTime: number, trails: Container, bodies: Container, overlay: Container, isSelf: boolean) {
    this.id = info.id;
    this.name = info.name;
    this.appearance = info.appearance;
    this.x = info.x;
    this.y = info.y;
    this.dir = info.dir;
    this.moving = info.moving;
    this.role = info.role;
    this.isSelf = isSelf;

    const look = appearanceOf(info.appearance);
    this.color = look.color;
    this.kind = look.kind;

    const glow = new Sprite({ texture: glowTexture(), anchor: 0.5, blendMode: "add", tint: this.color });
    glow.width = glow.height = SIZES[this.kind].glow;
    this.core = new BodyView(this.kind, look.colorIndex);
    this.ring = new Graphics().circle(0, 0, SIZES[this.kind].core * 2.4).stroke({ color: ROLE_COLOR, width: 2, alpha: 0.9 });
    this.body.addChild(glow, this.ring, this.core.view);
    bodies.addChild(this.body);
    if (isSelf) {
      // Outside the body so it does not fade with it.
      this.marker = new Graphics().circle(0, 0, 26).stroke({ color: 0xffffff, width: 1.5, alpha: 1 });
      this.marker.alpha = 0;
      bodies.addChild(this.marker);
    }
    this.trail.blendMode = "add";
    // A comet draws its own tail.
    this.trail.renderable = this.kind !== "comet";
    trails.addChild(this.trail);

    this.label = new Text({
      text: info.name,
      style: {
        fontFamily: "Space Grotesk, system-ui, sans-serif",
        fontSize: 13,
        fontWeight: "500",
        fill: isSelf ? 0xffe9a8 : 0xe8ecff,
        stroke: { color: 0x05060d, width: 4, join: "round" },
      },
    });
    this.label.anchor.set(0.5, 1);
    this.roleTag = new Text({
      text: "",
      style: {
        fontFamily: "Space Grotesk, system-ui, sans-serif",
        fontSize: 10,
        fontWeight: "700",
        letterSpacing: 1.2,
        fill: ROLE_COLOR,
        stroke: { color: 0x05060d, width: 3, join: "round" },
      },
    });
    this.roleTag.anchor.set(0.5, 1);
    this.tag.addChild(this.roleTag, this.label, this.floating);
    overlay.addChild(this.tag);
    this.setRole(info.role);

    this.pushSample(serverTime, info);
  }

  setRole(role: Role): void {
    this.role = role;
    const host = role === "host";
    this.body.visible = !host;
    this.trail.visible = !host;
    this.ring.visible = role === "speaker";
    this.roleTag.visible = role !== "guest";
    this.roleTag.text = ROLE_LABELS[role].toUpperCase();
    this.label.style.fontSize = host ? 16 : 13;
    this.label.style.fill = host || this.isSelf ? 0xffe9a8 : 0xe8ecff;
    this.roleTag.y = -this.label.height - 1;
    if (host) {
      this.x = WORLD_CENTER.x;
      this.y = WORLD_CENTER.y;
      this.trailPoints.length = 0;
    }
  }

  /** How loud the player is talking right now (0..1); drives the speaking glow. */
  /** Float an emoji up from the player. False when too many are already on screen. */
  react(kind: number, now = performance.now()): boolean {
    if (liveReactions >= MAX_LIVE_REACTIONS) return false;
    if (this.reactions.length >= MAX_REACTIONS_PER_AVATAR) this.dropReaction(0);
    const sprite = new Sprite({ texture: emojiTexture(REACTIONS[kind].emoji), anchor: 0.5 });
    sprite.width = sprite.height = REACTION_SIZE;
    this.floating.addChild(sprite);
    this.reactions.push({ sprite, born: now, drift: (Math.random() - 0.5) * 24 });
    liveReactions++;
    this.reactedUntil = now + 500;
    return true;
  }

  private dropReaction(i: number): void {
    const [r] = this.reactions.splice(i, 1);
    r.sprite.destroy();
    liveReactions--;
  }

  private renderReactions(now: number): void {
    this.floating.y = this.headroom() - 6;
    for (let i = this.reactions.length - 1; i >= 0; i--) {
      const r = this.reactions[i];
      const t = (now - r.born) / REACTION_MS;
      if (t >= 1) {
        this.dropReaction(i);
        continue;
      }
      r.sprite.position.set(r.drift * t, -REACTION_RISE * t);
      r.sprite.alpha = 1 - t * t;
      const pop = Math.min(1, t * 6);
      r.sprite.width = r.sprite.height = REACTION_SIZE * (0.6 + 0.4 * pop);
    }
  }

  /** Show (or hide) a raised hand next to the name. */
  setHand(raised: boolean): void {
    if (raised && !this.handIcon) {
      this.handIcon = new Sprite({ texture: emojiTexture("✋"), anchor: { x: 1, y: 1 } });
      this.handIcon.width = this.handIcon.height = 18;
      this.tag.addChild(this.handIcon);
    }
    if (this.handIcon) this.handIcon.visible = raised;
  }

  setVoiceLevel(level: number): void {
    this.voiceLevel = Math.min(1, level);
  }

  /** Update facing and motion (drives the trail). */
  setMotion(dir: Direction, moving: boolean): void {
    this.dir = dir;
    this.moving = moving;
  }

  /** Jump to a position without blending from the old one (e.g. back in view after a while). */
  teleport(t: number, s: { x: number; y: number; dir: Direction; moving: boolean }): void {
    this.track.clear();
    this.trailPoints.length = 0;
    this.x = s.x;
    this.y = s.y;
    this.pushSample(t, s);
  }

  /** A position the server had at server time `t`. */
  pushSample(t: number, s: { x: number; y: number; dir: Direction; moving: boolean }): void {
    this.track.push({ t, x: s.x, y: s.y, dir: s.dir, moving: s.moving });
  }

  /** Place a remote player where it was at server time `t` (see PlayoutClock). */
  interpolate(t: number): void {
    const p = this.track.at(t);
    if (!p) return;
    this.x = p.x;
    this.y = p.y;
    this.setMotion(p.dir, p.moving);
  }

  showBubble(text: string): void {
    this.bubble?.destroy({ children: true });

    const content = new Text({
      text,
      style: {
        fontFamily: "Space Grotesk, system-ui, sans-serif",
        fontSize: 13,
        fill: 0x0d1024,
        wordWrap: true,
        wordWrapWidth: BUBBLE_MAX_WIDTH,
        breakWords: true,
      },
    });
    const padX = 10;
    const padY = 6;
    const w = content.width + padX * 2;
    const h = content.height + padY * 2;
    const bg = new Graphics()
      .roundRect(-w / 2, -h - 7, w, h, 10)
      .fill({ color: 0xf1f3ff, alpha: 0.96 })
      .poly([-5, -8, 5, -8, 0, 0])
      .fill({ color: 0xf1f3ff, alpha: 0.96 });
    content.position.set(-w / 2 + padX, -h - 7 + padY);

    this.bubble = new Container();
    this.bubble.addChild(bg, content);
    this.bubble.y = this.headroom();
    this.tag.addChild(this.bubble);
    this.bubbleUntil = performance.now() + BUBBLE_MS;
  }

  /** Where the bubble starts above the tag's anchor. */
  private headroom(): number {
    return -this.label.height - (this.roleTag.visible ? this.roleTag.height : 0) - 4;
  }

  /**
   * Sync the drawing with the current position; call once per frame after the
   * camera moves. `visibility` (0..1) is the area-of-interest fog.
   */
  render(now: number, worldX: number, worldY: number, zoom: number, visibility = 1): void {
    if (this.role === "host") {
      this.renderOnSun(now, worldX, worldY, zoom);
      return;
    }
    const brightness = brightnessAt(this.x, this.y) * visibility;
    this.body.visible = brightness > 0.01;
    this.trail.visible = this.body.visible;
    const scale = Math.max(1, MIN_SCREEN_SCALE / zoom);
    this.body.position.set(this.x, this.y);
    this.body.scale.set(scale);
    this.body.alpha = brightness;
    this.trackVelocity(now);
    const voice = now < this.reactedUntil ? Math.max(this.voiceLevel, 0.7) : this.voiceLevel;
    if (this.body.visible) this.core.update(now, { ...this.velocity, moving: this.moving }, voice);
    if (this.ring.visible) {
      this.ring.scale.set(1 + this.voiceLevel * 0.45);
      this.ring.alpha = 0.45 + this.voiceLevel * 0.55;
    }
    if (this.marker) {
      this.marker.position.set(this.x, this.y);
      this.marker.scale.set(scale);
      this.marker.alpha = Math.max(0, 0.55 - brightness) * 1.6;
    }

    this.renderTrail(now, brightness, scale);

    const radius = SIZES[this.kind].core * 2.2 * scale * zoom;
    this.tag.position.set(Math.round(worldX + this.x * zoom), Math.round(worldY + this.y * zoom - radius - 6));
    // Faded players disappear from view, name and bubble included; you still see your own.
    this.tag.alpha = this.isSelf ? Math.max(brightness, 0.6) : brightness;
    this.tag.visible = this.tag.alpha > 0.02;
    this.renderBubble(now);
    this.renderTagExtras(now);
  }

  private trackVelocity(now: number): void {
    const last = this.lastDrawn;
    const dt = (now - last.t) / 1000;
    if (dt > 0 && dt < 0.25) {
      // Smoothed: interpolated positions arrive in small uneven steps.
      const k = 0.25;
      this.velocity.vx += ((this.x - last.x) / dt - this.velocity.vx) * k;
      this.velocity.vy += ((this.y - last.y) / dt - this.velocity.vy) * k;
    } else {
      this.velocity.vx = this.velocity.vy = 0;
    }
    last.x = this.x;
    last.y = this.y;
    last.t = now;
  }

  private renderTagExtras(now: number): void {
    if (this.reactions.length > 0) this.renderReactions(now);
    if (this.handIcon?.visible) this.handIcon.position.set(-this.label.width / 2 - 3, -1);
  }

  /** The host's name and bubble float above the sun. */
  private renderOnSun(now: number, worldX: number, worldY: number, zoom: number): void {
    this.marker?.position.set(this.x, this.y);
    if (this.marker) this.marker.alpha = 0;
    this.tag.position.set(
      Math.round(worldX + WORLD_CENTER.x * zoom),
      Math.round(worldY + (WORLD_CENTER.y - SUN_RADIUS * 0.85) * zoom - 8),
    );
    this.tag.alpha = 1;
    this.tag.visible = true;
    this.renderBubble(now);
    this.renderTagExtras(now);
  }

  private renderBubble(now: number): void {
    if (this.bubble) {
      const left = this.bubbleUntil - now;
      if (left <= 0) {
        this.bubble.destroy({ children: true });
        this.bubble = null;
      } else {
        this.bubble.alpha = Math.min(1, left / 400);
        this.bubble.y = this.headroom();
      }
    }
  }

  private renderTrail(now: number, brightness: number, scale: number): void {
    const pts = this.trailPoints;
    if (this.moving && now - this.lastTrailAt >= TRAIL_EVERY_MS) {
      pts.push({ x: this.x, y: this.y });
      if (pts.length > TRAIL_POINTS) pts.shift();
      this.lastTrailAt = now;
    } else if (!this.moving && pts.length > 0 && now - this.lastTrailAt >= TRAIL_EVERY_MS) {
      pts.shift(); // let the trail shrink away once stopped
      this.lastTrailAt = now;
    }
    this.trail.clear();
    if (pts.length < 2 || brightness <= 0) return;
    // Capped so big bodies do not drag a fat band behind them.
    const width = Math.min(SIZES[this.kind].core, 11) * 1.1 * scale;
    for (let i = 1; i < pts.length; i++) {
      const k = i / pts.length;
      this.trail
        .moveTo(pts[i - 1].x, pts[i - 1].y)
        .lineTo(pts[i].x, pts[i].y)
        .stroke({ color: this.color, width: width * k, alpha: 0.5 * k * brightness, cap: "round" });
    }
    const head = pts.at(-1)!;
    this.trail.moveTo(head.x, head.y).lineTo(this.x, this.y).stroke({
      color: this.color,
      width,
      alpha: 0.5 * brightness,
      cap: "round",
    });
  }

  destroy(): void {
    while (this.reactions.length > 0) this.dropReaction(0);
    this.body.destroy({ children: true });
    this.marker?.destroy();
    this.trail.destroy();
    this.tag.destroy({ children: true });
  }
}
