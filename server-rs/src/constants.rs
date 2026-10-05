//! Mirrors shared/src/constants.ts (the TypeScript server and the browser client).

pub const WORLD_CENTER: (f64, f64) = (5_000.0, 5_000.0);
pub const WORLD_RADIUS: f64 = 5_000.0;
pub const SUN_RADIUS: f64 = 200.0;
pub const MOVE_SPEED: f64 = 400.0;
pub const SPAWN_NEAR: (f64, f64) = (120.0, 320.0);
pub const SPAWN_RING: (f64, f64) = (900.0, 1_600.0);

pub const TICK_RATE: u32 = 20;
pub const SNAPSHOT_GROUPS_AT: usize = 200;
pub const SNAPSHOT_GROUPS_OFF_BELOW: usize = 150;
pub const OVERCHARGE_FORCE_AT: usize = 2_000;

pub const AOI_RADIUS: f64 = 1_500.0;
pub const AOI_CELL: f64 = 375.0;

pub const MAX_NAME_LENGTH: usize = 20;
pub const MAX_CHAT_LENGTH: usize = 280;
pub const CHAT_HISTORY_SIZE: usize = 100;
pub const APPEARANCE_COUNT: u8 = 88;

pub const MAX_SPEAKERS: usize = 8;
pub const MAX_VOICE_FRAME_BYTES: usize = 512;
pub const VOICE_FLUSH_MS: f64 = 100.0;
pub const VOICE_BYTES_PER_SEC: f64 = 8_000.0;

/// Largest client frame accepted; real ones are tens of bytes.
pub const MAX_FRAME_BYTES: usize = 4 * 1024;
