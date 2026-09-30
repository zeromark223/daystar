import { VOICE_BITRATE, VOICE_FRAME_MS, VOICE_SAMPLE_RATE } from "../../../shared/src/constants.ts";
import type { VoiceFrame } from "../../../shared/src/protocol.ts";
import type { EncodedFrame, FromWorker, ToPlayback, ToWorker } from "./messages.ts";

/**
 * Voice worker: Opus encoding of the microphone and decoding of every speaker,
 * off the main thread (see messages.ts).
 */

const scope = self as unknown as Worker;
const FRAME_US = VOICE_FRAME_MS * 1000;

// ------------------------------------------------------------ decoding

/** Decoders of speakers silent this long are released. */
const IDLE_MS = 15_000;

interface Speaker {
  decoder: AudioDecoder;
  lastSeq: number | null;
  /** Per frame sent to the decoder, in order: does it follow the previous one? */
  continuity: boolean[];
  timestamp: number;
  heardAt: number;
}

const speakers = new Map<number, Speaker>();
let playback: MessagePort | null = null;

function speaker(id: number): Speaker {
  const existing = speakers.get(id);
  if (existing && existing.decoder.state !== "closed") return existing;
  const s: Speaker = {
    decoder: new AudioDecoder({
      output: (data) => {
        const samples = new Float32Array(data.numberOfFrames);
        data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
        data.close();
        const msg: ToPlayback = { t: "pcm", id, continuous: s.continuity.shift() ?? false, samples };
        playback?.postMessage(msg, [samples.buffer]);
      },
      error: (e) => console.warn("voice decoder:", e),
    }),
    lastSeq: null,
    continuity: [],
    timestamp: 0,
    heardAt: 0,
  };
  s.decoder.configure({ codec: "opus", sampleRate: VOICE_SAMPLE_RATE, numberOfChannels: 1 });
  speakers.set(id, s);
  return s;
}

function decode(frames: VoiceFrame[]): void {
  const now = performance.now();
  for (const f of frames) {
    const s = speaker(f.id);
    if (s.decoder.state !== "configured") continue;
    // A jump in seq means the speaker paused (or muted): a new talk spurt.
    s.continuity.push(s.lastSeq !== null && f.seq === ((s.lastSeq + 1) & 0xffff));
    s.lastSeq = f.seq;
    s.timestamp += FRAME_US;
    s.heardAt = now;
    s.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: s.timestamp, data: f.data }));
  }
}

function removeSpeaker(id: number): void {
  const s = speakers.get(id);
  if (s && s.decoder.state !== "closed") s.decoder.close();
  speakers.delete(id);
  playback?.postMessage({ t: "remove", id } satisfies ToPlayback);
}

setInterval(() => {
  const now = performance.now();
  for (const [id, s] of speakers) if (now - s.heardAt > IDLE_MS) removeSpeaker(id);
}, IDLE_MS);

// ------------------------------------------------------------ encoding

/** Voice gate: a frame louder than this (RMS) opens it... */
const GATE_OPEN_RMS = 0.012;
/** ...and it stays open this many frames after the last loud one, so words are not clipped. */
const GATE_HANGOVER_FRAMES = 20;
/** Frames kept from before the gate opened, so the first syllable is not lost. */
const PRE_ROLL_FRAMES = 3;
/** Send the mic level to main at least this often while nothing is being encoded. */
const LEVEL_EVERY_MS = 100;

let encoder: AudioEncoder | null = null;
let capture: MessagePort | null = null;
let muted = false;
/**
 * Counts every 20 ms of microphone time, sent or not. A frame's seq is its index,
 * so listeners see a jump after silence or a mute and start a new talk spurt
 * instead of mistaking the pause for a network stall.
 */
let frameIndex = 0;
let openFor = 0;
const preRoll: { frame: Float32Array<ArrayBuffer>; index: number }[] = [];
let level = 0;
let outbox: EncodedFrame[] = [];
/** One batch in flight at a time: a busy main thread gets bigger batches, not a backlog of messages. */
let inFlight = false;
let lastPost = 0;

function flush(): void {
  if (inFlight) return;
  if (outbox.length === 0 && performance.now() - lastPost < LEVEL_EVERY_MS) return;
  const msg: FromWorker = { t: "encoded", frames: outbox, level };
  scope.postMessage(msg, outbox.map((f) => f.data.buffer as ArrayBuffer));
  outbox = [];
  inFlight = true;
  lastPost = performance.now();
}

function startMic(port: MessagePort): void {
  stopMic();
  capture = port;
  encoder = new AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      outbox.push({ seq: Math.round(chunk.timestamp / FRAME_US) & 0xffff, data });
      flush();
    },
    error: (e) => console.warn("voice encoder:", e),
  });
  encoder.configure({
    codec: "opus",
    sampleRate: VOICE_SAMPLE_RATE,
    numberOfChannels: 1,
    bitrate: VOICE_BITRATE,
    opus: { frameDuration: FRAME_US },
  });
  port.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer>>) => onMicFrame(e.data);
}

function stopMic(): void {
  capture?.close();
  capture = null;
  if (encoder && encoder.state !== "closed") encoder.close();
  encoder = null;
  openFor = 0;
  preRoll.length = 0;
  level = 0;
}

function onMicFrame(frame: Float32Array<ArrayBuffer>): void {
  const index = frameIndex++;
  if (muted || !encoder) {
    flush();
    return;
  }
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  level = Math.max(rms * 6, level * 0.85);

  if (rms >= GATE_OPEN_RMS) {
    if (openFor === 0) for (const early of preRoll.splice(0)) encode(early.frame, early.index);
    openFor = GATE_HANGOVER_FRAMES;
  }
  if (openFor > 0) {
    openFor--;
    encode(frame, index);
  } else {
    preRoll.push({ frame, index });
    if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
  }
  flush();
}

function encode(frame: Float32Array<ArrayBuffer>, index: number): void {
  const data = new AudioData({
    format: "f32-planar",
    sampleRate: VOICE_SAMPLE_RATE,
    numberOfFrames: frame.length,
    numberOfChannels: 1,
    timestamp: index * FRAME_US,
    data: frame,
  });
  encoder!.encode(data);
  data.close();
}

// ------------------------------------------------------------ messages from main

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.t) {
    case "init":
      playback = m.playback;
      break;
    case "frames":
      decode(m.frames);
      break;
    case "remove":
      removeSpeaker(m.id);
      break;
    case "clear":
      for (const id of [...speakers.keys()]) removeSpeaker(id);
      playback?.postMessage({ t: "clear" } satisfies ToPlayback);
      break;
    case "mic":
      if (m.capture) startMic(m.capture);
      else stopMic();
      break;
    case "mute":
      muted = m.muted;
      if (muted) {
        level = 0;
        openFor = 0;
        preRoll.length = 0;
      }
      break;
    case "ack":
      inFlight = false;
      flush();
      break;
  }
};
