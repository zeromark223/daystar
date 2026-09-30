import type { VoiceFrame } from "../../../shared/src/protocol.ts";
import { audioContext } from "./audio.ts";
import { post } from "./engine.ts";
import type { PlaybackStats, ToWorkletNode } from "./messages.ts";
import playbackUrl from "./playback.worklet.ts?worker&url";

/**
 * Plays every speaker: frames go to the voice worker for decoding, and the PCM
 * flows from there straight to a playback worklet on the audio thread (adaptive
 * delay and mixing, see playout.ts). This class only forwards and reads stats.
 */
export class VoicePlayer {
  /** Frames scheduled so far (for ?debug and tests). */
  framesPlayed = 0;
  private readonly stats = new Map<number, { level: number; delayMs: number }>();
  /** Our end of the worker -> worklet channel, handed to the worklet once it exists. */
  private port: MessagePort | null;
  private starting: Promise<void> | null = null;
  private output: GainNode | null = null;
  private muted = false;

  static supported(): boolean {
    return typeof AudioDecoder !== "undefined" && typeof AudioWorkletNode !== "undefined";
  }

  constructor() {
    const channel = new MessageChannel();
    this.port = channel.port1;
    if (VoicePlayer.supported()) post({ t: "init", playback: channel.port2 }, [channel.port2]);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.output) this.output.gain.value = muted ? 0 : 1;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Frames of one server message (the caller already left out our own). */
  push(frames: VoiceFrame[]): void {
    if (!VoicePlayer.supported() || frames.length === 0) return;
    this.starting ??= this.start();
    post({ t: "frames", frames }, frames.map((f) => f.data.buffer as ArrayBuffer));
  }

  /** How loud `id` is right now, 0..1. */
  level(id: number): number {
    return this.stats.get(id)?.level ?? 0;
  }

  /** Current playout delay for `id` in ms (for ?debug). */
  delayMs(id: number): number | null {
    return this.stats.get(id)?.delayMs ?? null;
  }

  remove(id: number): void {
    this.stats.delete(id);
    post({ t: "remove", id });
  }

  clear(): void {
    this.stats.clear();
    post({ t: "clear" });
  }

  private async start(): Promise<void> {
    const ctx = audioContext();
    await ctx.audioWorklet.addModule(playbackUrl);
    const node = new AudioWorkletNode(ctx, "daystar-playback", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.port.onmessage = (e: MessageEvent<PlaybackStats>) => {
      this.framesPlayed = e.data.played;
      this.stats.clear();
      for (const [id, level, delayMs] of e.data.speakers) this.stats.set(id, { level, delayMs });
      node.port.postMessage({ t: "ack" } satisfies ToWorkletNode);
    };
    node.port.postMessage({ t: "port", port: this.port! } satisfies ToWorkletNode, [this.port!]);
    this.port = null;
    this.output = ctx.createGain();
    this.output.gain.value = this.muted ? 0 : 1;
    node.connect(this.output).connect(ctx.destination);
  }
}
