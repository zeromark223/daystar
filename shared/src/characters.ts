export const DIRECTIONS = ["south", "west", "east", "north"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export type AnimationState = "idle" | "run";

export interface CharacterDef {
  label: string;
  /** Integer render scale so small animals are not lost on the map. */
  scale: number;
  idleFps: number;
  runFps: number;
}

export const CHARACTERS = {
  deer: { label: "Deer", scale: 1, idleFps: 8, runFps: 12 },
  rabbit_brown: { label: "Brown Rabbit", scale: 2, idleFps: 8, runFps: 14 },
  rabbit_white: { label: "White Rabbit", scale: 2, idleFps: 8, runFps: 14 },
  rabbit_gray: { label: "Gray Rabbit", scale: 2, idleFps: 8, runFps: 14 },
  wolf_gray: { label: "Gray Wolf", scale: 1, idleFps: 8, runFps: 13 },
  wolf_white: { label: "White Wolf", scale: 1, idleFps: 8, runFps: 13 },
  wolf_black: { label: "Black Wolf", scale: 1, idleFps: 8, runFps: 13 },
} as const satisfies Record<string, CharacterDef>;

export type CharacterId = keyof typeof CHARACTERS;

export const CHARACTER_IDS = Object.keys(CHARACTERS) as CharacterId[];

export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === "string" && Object.hasOwn(CHARACTERS, value);
}

export function animationName(state: AnimationState, dir: Direction): string {
  return `${state}_${dir}`;
}
