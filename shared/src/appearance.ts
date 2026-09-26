/**
 * How a player looks: a kind of celestial body in one of the palette colors.
 * Drawn procedurally by the client; on the wire it is one byte, kind * colors + color.
 */

export const BODY_KINDS = ["star", "planet", "ringed"] as const;
export type BodyKind = (typeof BODY_KINDS)[number];

export const BODY_LABELS: Record<BodyKind, string> = {
  star: "Star",
  planet: "Planet",
  ringed: "Ringed planet",
};

export const PALETTE = [
  { name: "Gold", color: 0xffd166 },
  { name: "Ember", color: 0xff8c5a },
  { name: "Rose", color: 0xff7eb6 },
  { name: "Violet", color: 0xb38cff },
  { name: "Azure", color: 0x6cb8ff },
  { name: "Aqua", color: 0x5ee6d6 },
  { name: "Mint", color: 0x8ef08a },
  { name: "Pearl", color: 0xeef2ff },
] as const;

export type AppearanceId = number;
export const APPEARANCE_COUNT = BODY_KINDS.length * PALETTE.length;
export const DEFAULT_APPEARANCE: AppearanceId = 0;

export interface Appearance {
  kind: BodyKind;
  colorIndex: number;
  color: number;
}

export function isAppearanceId(value: unknown): value is AppearanceId {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < APPEARANCE_COUNT;
}

export function appearanceId(kind: BodyKind, colorIndex: number): AppearanceId {
  return BODY_KINDS.indexOf(kind) * PALETTE.length + colorIndex;
}

export function appearanceOf(id: AppearanceId): Appearance {
  const safe = isAppearanceId(id) ? id : DEFAULT_APPEARANCE;
  const colorIndex = safe % PALETTE.length;
  return { kind: BODY_KINDS[Math.floor(safe / PALETTE.length)], colorIndex, color: PALETTE[colorIndex].color };
}
