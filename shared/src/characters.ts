export const DIRECTIONS = ["south", "west", "east", "north"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export type AnimationState = "idle" | "run";

export interface CharacterDef {
  label: string;
  /** Integer render scale so small animals are not lost on the map. */
  scale: number;
  /** Visible body height in sprite pixels (before scale), from the sheet's meta.height. */
  height: number;
  idleFps: number;
  runFps: number;
}

export const CHARACTERS = {
  deer: { label: "Deer", scale: 1, height: 74, idleFps: 8, runFps: 12 },
  rabbit_brown: { label: "Brown Rabbit", scale: 2, height: 25, idleFps: 8, runFps: 14 },
  rabbit_white: { label: "White Rabbit", scale: 2, height: 25, idleFps: 8, runFps: 14 },
  rabbit_gray: { label: "Gray Rabbit", scale: 2, height: 25, idleFps: 8, runFps: 14 },
  wolf_gray: { label: "Gray Wolf", scale: 1, height: 45, idleFps: 8, runFps: 13 },
  wolf_white: { label: "White Wolf", scale: 1, height: 45, idleFps: 8, runFps: 13 },
  wolf_black: { label: "Black Wolf", scale: 1, height: 45, idleFps: 8, runFps: 13 },
} as const satisfies Record<string, CharacterDef>;

export type CharacterId = keyof typeof CHARACTERS;

export const CHARACTER_IDS = Object.keys(CHARACTERS) as CharacterId[];

export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === "string" && Object.hasOwn(CHARACTERS, value);
}

/**
 * How far above the feet the collision circle sits: the middle of the visible body,
 * so walls stop a character at its torso rather than its toes.
 */
export function collisionOffsetY(id: CharacterId): number {
  const def: CharacterDef = CHARACTERS[id];
  return Math.round((def.height * def.scale) / 2);
}

export function animationName(state: AnimationState, dir: Direction): string {
  return `${state}_${dir}`;
}
