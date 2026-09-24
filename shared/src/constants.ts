export const MAP_WIDTH = 1200;
export const MAP_HEIGHT = 1200;

/** Where new players appear (map pixel coords). */
export const SPAWN_POINT = { x: 540, y: 600 };
export const SPAWN_RADIUS = 48;

/** Movement speed in map pixels per second, shared by every character. */
export const MOVE_SPEED = 110;

/** Server snapshot rate and client position send rate. */
export const TICK_RATE = 20;

export const MAX_NAME_LENGTH = 20;
export const MAX_CHAT_LENGTH = 280;
export const CHAT_HISTORY_SIZE = 100;

/** Rooms are addressed as /r/<room-id>. */
export const ROOM_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

export const WS_PATH = "/ws";
