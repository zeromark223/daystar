import type { VoiceFrame } from "../../../shared/src/protocol.ts";

/**
 * Voice runs on three threads so a busy main thread (rendering) cannot starve it:
 * - main: the WebSocket; forwards received frames, sends encoded ones;
 * - voice.worker: Opus encode (mic) and decode (speakers) with WebCodecs;
 * - AudioWorklets on the audio thread: capture (mic frames straight to the
 *   worker) and playback (PCM straight from the worker, mixing, adaptive delay).
 */

export interface EncodedFrame {
  seq: number;
  data: Uint8Array;
}

/** main -> worker */
export type ToWorker =
  /** The port leading to the playback worklet. */
  | { t: "init"; playback: MessagePort }
  /** Frames from one server message (one post per WebSocket message). */
  | { t: "frames"; frames: VoiceFrame[] }
  | { t: "remove"; id: number }
  | { t: "clear" }
  /** Start encoding from a capture worklet port, or stop (null). */
  | { t: "mic"; capture: MessagePort | null }
  | { t: "mute"; muted: boolean }
  /** Main handled the last "encoded" batch; the worker may send the next one. */
  | { t: "ack" };

/** worker -> main: encoded mic frames since the last batch, and the mic level. */
export type FromWorker = { t: "encoded"; frames: EncodedFrame[]; level: number };

/** worker -> playback worklet */
export type ToPlayback =
  | { t: "pcm"; id: number; continuous: boolean; samples: Float32Array<ArrayBuffer> }
  | { t: "remove"; id: number }
  | { t: "clear" };

/** main -> worklet (either one), over the node's own port. */
export type ToWorkletNode = { t: "port"; port: MessagePort } | { t: "ack" };

/** playback worklet -> main, a few times per second: [id, level 0..1, delay ms]. */
export type PlaybackStats = { t: "stats"; played: number; speakers: [number, number, number][] };
