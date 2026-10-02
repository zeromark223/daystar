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

/**
 * Snapshot groups: once a room has this many players on one server, the server
 * splits them in two groups served on alternate ticks, so each player gets
 * snapshots at TICK_RATE / 2 (half the sends and bytes, and half the players per
 * tick's burst). Below SNAPSHOT_GROUPS_OFF_BELOW everyone gets every tick again.
 */
export const SNAPSHOT_GROUPS_AT = 700;
export const SNAPSHOT_GROUPS_OFF_BELOW = 600;

export const MAX_NAME_LENGTH = 20;
export const MAX_CHAT_LENGTH = 280;
export const CHAT_HISTORY_SIZE = 100;

/** Rooms are addressed as /r/<room-id>. */
export const ROOM_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

export const WS_PATH = "/ws";

/** The host may choose at most this many speakers at once. */
export const MAX_SPEAKERS = 8;

// Voice: Opus via WebCodecs, 20 ms frames at 48 kHz mono, relayed by the server
// inside the tick frame (see docs/voice.md).
export const VOICE_SAMPLE_RATE = 48_000;
export const VOICE_FRAME_MS = 20;
export const VOICE_BITRATE = 24_000;
/** Largest Opus frame accepted from a client (24 kbps x 20 ms is ~60 B). */
export const MAX_VOICE_FRAME_BYTES = 512;
/**
 * In a room where nobody moves, voice waits for this long and goes out in its own
 * frame (5 Opus frames); otherwise it rides the next snapshot (every 50 ms).
 */
export const VOICE_FLUSH_MS = 100;
/** Voice bytes a speaker may send per second before frames are dropped (~64 kbps). */
export const VOICE_BYTES_PER_SEC = 8_000;
