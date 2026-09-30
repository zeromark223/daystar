import { Container, Graphics, Sprite, TilingSprite } from "pixi.js";
import { FADE_START, SUN_RADIUS, WORLD_CENTER, WORLD_RADIUS } from "../../../shared/src/constants.ts";
import { glowTexture, seededRandom, starTileTexture } from "./textures.ts";

/** Screen-space star layers drift slower than the world to suggest depth. */
const LAYERS = [
  { parallax: 0.04, size: 512, count: 260, maxRadius: 0.9, seed: 11 },
  { parallax: 0.12, size: 640, count: 110, maxRadius: 1.4, seed: 23 },
  { parallax: 0.28, size: 768, count: 45, maxRadius: 2.1, seed: 37 },
];

/**
 * Everything that is not a player: the starry sky, a few nebulae, the edge of the
 * world and the sun. Built from generated textures and vector graphics only.
 */
export class SpaceScene {
  /** Behind the world, in screen space. */
  readonly sky = new Container();
  /** In world space, under the players. */
  readonly backdrop = new Container();
  private readonly layers: TilingSprite[] = [];
  private readonly sun = new Container();
  private readonly rays = new Graphics();
  private readonly corona: Sprite;
  private readonly halo: Sprite;
  /** The host's voice level (the host is the sun), 0..1, eased per frame. */
  private hostLevel = 0;
  private hostTarget = 0;

  constructor() {
    for (const spec of LAYERS) {
      const layer = new TilingSprite({ texture: starTileTexture(spec), width: 1, height: 1 });
      this.layers.push(layer);
      this.sky.addChild(layer);
    }

    // Faint nebulae scattered through the world, always the same.
    const random = seededRandom(7);
    const nebulaColors = [0x3b2a7a, 0x183f6b, 0x5a2350, 0x14504c];
    for (let i = 0; i < 9; i++) {
      const angle = random() * Math.PI * 2;
      const r = 1400 + random() * 3200;
      const cloud = new Sprite({ texture: glowTexture(), anchor: 0.5, blendMode: "add" });
      cloud.position.set(WORLD_CENTER.x + Math.cos(angle) * r, WORLD_CENTER.y + Math.sin(angle) * r);
      cloud.width = cloud.height = 1600 + random() * 2200;
      cloud.tint = nebulaColors[i % nebulaColors.length];
      cloud.alpha = 0.35 + random() * 0.25;
      this.backdrop.addChild(cloud);
    }

    // The edge of the world, and where players start to fade.
    const edge = new Graphics()
      .circle(WORLD_CENTER.x, WORLD_CENTER.y, WORLD_RADIUS)
      .stroke({ color: 0x7a8cff, width: 6, alpha: 0.28 })
      .circle(WORLD_CENTER.x, WORLD_CENTER.y, WORLD_RADIUS * FADE_START)
      .stroke({ color: 0x7a8cff, width: 3, alpha: 0.08 });
    this.backdrop.addChild(edge);

    // The sun: a wide corona, slowly turning rays, a hot core.
    this.corona = new Sprite({ texture: glowTexture(), anchor: 0.5, blendMode: "add", tint: 0xff9a3c });
    this.corona.width = this.corona.height = SUN_RADIUS * 7;
    this.corona.alpha = 0.9;
    const halo = new Sprite({ texture: glowTexture(), anchor: 0.5, blendMode: "add", tint: 0xffd27a });
    halo.width = halo.height = SUN_RADIUS * 3.4;
    this.halo = halo;
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      const long = i % 2 === 0 ? SUN_RADIUS * 2.1 : SUN_RADIUS * 1.55;
      const w = 0.035;
      this.rays
        .poly([
          Math.cos(a - w) * SUN_RADIUS * 0.7,
          Math.sin(a - w) * SUN_RADIUS * 0.7,
          Math.cos(a) * long,
          Math.sin(a) * long,
          Math.cos(a + w) * SUN_RADIUS * 0.7,
          Math.sin(a + w) * SUN_RADIUS * 0.7,
        ])
        .fill({ color: 0xffe2a0, alpha: 0.13 });
    }
    this.rays.blendMode = "add";
    const core = new Graphics()
      .circle(0, 0, SUN_RADIUS * 0.78)
      .fill({ color: 0xffb54a })
      .circle(0, 0, SUN_RADIUS * 0.66)
      .fill({ color: 0xffd98a })
      .circle(0, 0, SUN_RADIUS * 0.5)
      .fill({ color: 0xfff4d6 });
    const heart = new Sprite({ texture: glowTexture(), anchor: 0.5, blendMode: "add", tint: 0xffffff });
    heart.width = heart.height = SUN_RADIUS * 1.2;
    this.sun.addChild(this.corona, this.rays, halo, core, heart);
    this.sun.position.set(WORLD_CENTER.x, WORLD_CENTER.y);
    this.backdrop.addChild(this.sun);
  }

  /** The sun flares while the host talks. */
  setHostVoiceLevel(level: number): void {
    this.hostTarget = Math.min(1, level);
  }

  /** Call every frame with the camera (world position and zoom) and screen size. */
  update(time: number, worldX: number, worldY: number, zoom: number, width: number, height: number): void {
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      layer.width = width;
      layer.height = height;
      // Layers follow the camera at a fraction of its speed; nearer layers move more.
      const p = LAYERS[i].parallax;
      layer.tilePosition.set(worldX * p, worldY * p);
      layer.tileScale.set(0.75 + zoom * 0.25);
    }
    this.rays.rotation = time * 0.00004;
    this.hostLevel += (this.hostTarget - this.hostLevel) * 0.25;
    const pulse = 1 + Math.sin(time * 0.0012) * 0.035 + this.hostLevel * 0.18;
    this.corona.scale.set((SUN_RADIUS * 7 * pulse) / 256);
    this.halo.scale.set((SUN_RADIUS * 3.4 * (1 + this.hostLevel * 0.12)) / 256);
  }
}
