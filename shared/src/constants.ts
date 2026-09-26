/**
 * The world is a disc of WORLD_RADIUS around the sun at WORLD_CENTER, inside a
 * WORLD_SIZE square of map coordinates (pixels at zoom 1).
 */
export const WORLD_SIZE = 10_000;
export const WORLD_CENTER = { x: 5_000, y: 5_000 } as const;
export const WORLD_RADIUS = 5_000;
/** Players cannot get closer to the center than this (the sun). */
export const SUN_RADIUS = 200;
/** Beyond this share of WORLD_RADIUS players fade out, reaching invisible at the edge. */
export const FADE_START = 0.6;

/** Movement speed in map pixels per second, shared by everyone. */
export const MOVE_SPEED = 400;

/** Newcomers appear this far from a random player already in the room... */
export const SPAWN_NEAR = { min: 120, max: 320 } as const;
/** ...or, in an empty room, on this ring around the sun. */
export const SPAWN_RING = { min: 900, max: 1_600 } as const;

/** Server snapshot rate and client position send rate. */
export const TICK_RATE = 20;

export const MAX_NAME_LENGTH = 20;
export const MAX_CHAT_LENGTH = 280;
export const CHAT_HISTORY_SIZE = 100;

/** Rooms are addressed as /r/<room-id>. */
export const ROOM_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

export const WS_PATH = "/ws";
