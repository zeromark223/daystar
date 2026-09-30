import { VOICE_FRAME_MS, VOICE_SAMPLE_RATE } from "../../../shared/src/constants.ts";
import type { VoiceFrame } from "../../../shared/src/protocol.ts";
import { audioContext } from "./audio.ts";

/**
 * Playout delay. Frames arrive in bursts once per server tick (50 ms), so each
 * speaker is played this far behind real time to absorb the bursts and jitter.
 */
const TARGET_LEAD_S = 0.12;
/** Closer than this to running dry: restart the speaker at TARGET_LEAD_S. */
const MIN_LEAD_S = 0.02;
/** More queued than this (e.g. after the tab was in the background): skip ahead. */
const MAX_LEAD_S = 0.5;
/** Decoders of speakers silent this long are released. */
const IDLE_MS = 15_000;

interface Speaker {
  decoder: AudioDecoder;
  /** AudioContext time where the next frame starts. */
  playhead: number;
  timestamp: number;
  level: number;
  heardAt: number;
}

const DECODER_CONFIG: AudioDecoderConfig = { codec: "opus", sampleRate: VOICE_SAMPLE_RATE, numberOfChannels: 1 };

/** Decodes and plays every speaker's voice frames, each on its own schedule. */
export class VoicePlayer {
  private readonly speakers = new Map<number, Speaker>();
  private output: GainNode | null = null;
  /** Frames decoded and scheduled so far (for ?debug and tests). */
  framesPlayed = 0;
  private muted = false;

  static supported(): boolean {
    return typeof AudioDecoder !== "undefined";
  }

  constructor() {
    setInterval(() => this.sweep(), IDLE_MS);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.output) this.output.gain.value = muted ? 0 : 1;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  push(frame: VoiceFrame): void {
    if (!VoicePlayer.supported()) return;
    const s = this.speaker(frame.id);
    if (s.decoder.state !== "configured") return;
    s.timestamp += VOICE_FRAME_MS * 1000;
    s.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: s.timestamp, data: frame.data }));
  }

  /** How loud `id` is right now, 0..1 (fades out quickly after they stop). */
  level(id: number, now = performance.now()): number {
    const s = this.speakers.get(id);
    if (!s) return 0;
    return s.level * Math.exp(-(now - s.heardAt) / 180);
  }

  remove(id: number): void {
    const s = this.speakers.get(id);
    if (!s) return;
    if (s.decoder.state !== "closed") s.decoder.close();
    this.speakers.delete(id);
  }

  clear(): void {
    for (const id of [...this.speakers.keys()]) this.remove(id);
  }

  private speaker(id: number): Speaker {
    const existing = this.speakers.get(id);
    if (existing && existing.decoder.state !== "closed") return existing;
    const s: Speaker = {
      decoder: new AudioDecoder({
        output: (data) => this.play(s, data),
        error: (e) => console.warn("voice decoder:", e),
      }),
      playhead: 0,
      timestamp: 0,
      level: 0,
      heardAt: 0,
    };
    s.decoder.configure(DECODER_CONFIG);
    this.speakers.set(id, s);
    return s;
  }

  private play(s: Speaker, data: AudioData): void {
    const ctx = audioContext();
    if (!this.output) {
      this.output = ctx.createGain();
      this.output.gain.value = this.muted ? 0 : 1;
      this.output.connect(ctx.destination);
    }
    const samples = new Float32Array(data.numberOfFrames);
    data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
    const rate = data.sampleRate;
    data.close();

    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const now = performance.now();
    const decayed = s.level * Math.exp(-(now - s.heardAt) / 180);
    s.level = Math.max(Math.sqrt(sum / samples.length) * 6, decayed);
    s.heardAt = now;

    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const lead = s.playhead - ctx.currentTime;
    if (lead < MIN_LEAD_S || lead > MAX_LEAD_S) s.playhead = ctx.currentTime + TARGET_LEAD_S;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.output);
    node.start(s.playhead);
    s.playhead += buffer.duration;
    this.framesPlayed++;
  }

  private sweep(): void {
    const now = performance.now();
    for (const [id, s] of this.speakers) if (now - s.heardAt > IDLE_MS) this.remove(id);
  }
}
