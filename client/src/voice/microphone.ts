import { VOICE_BITRATE, VOICE_FRAME_MS, VOICE_SAMPLE_RATE } from "../../../shared/src/constants.ts";
import { audioContext } from "./audio.ts";

const FRAME_SAMPLES = (VOICE_SAMPLE_RATE * VOICE_FRAME_MS) / 1000;
/** Voice gate: a frame louder than this (RMS) opens it... */
const GATE_OPEN_RMS = 0.012;
/** ...and it stays open this many frames after the last loud one, so words are not clipped. */
const GATE_HANGOVER_FRAMES = 20;
/** Frames kept from before the gate opened, so the first syllable is not lost. */
const PRE_ROLL_FRAMES = 3;

/** Runs on the audio thread: collects the mic signal into whole 20 ms frames. */
const TAP_WORKLET = `
class DaystarTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(${FRAME_SAMPLES});
    this.filled = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    let i = 0;
    while (i < input.length) {
      const n = Math.min(input.length - i, this.frame.length - this.filled);
      this.frame.set(input.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(${FRAME_SAMPLES});
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("daystar-tap", DaystarTap);
`;

let workletLoaded: Promise<void> | null = null;

const ENCODER_CONFIG: AudioEncoderConfig = {
  codec: "opus",
  sampleRate: VOICE_SAMPLE_RATE,
  numberOfChannels: 1,
  bitrate: VOICE_BITRATE,
  opus: { frameDuration: VOICE_FRAME_MS * 1000 },
};

/**
 * The local microphone, for the host and speakers: echo-cancelled mic audio,
 * cut into 20 ms frames, Opus-encoded with WebCodecs. Only frames while the
 * person is actually talking are encoded and handed to `onFrame`.
 */
export class Microphone {
  /** Smoothed input level, 0..1, for the speaking glow (0 while muted). */
  level = 0;
  private readonly onFrame: (seq: number, data: Uint8Array) => void;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private tap: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private encoder: AudioEncoder | null = null;
  private muted = false;
  private seq = 0;
  private frameIndex = 0;
  private openFor = 0;
  private readonly preRoll: Float32Array<ArrayBuffer>[] = [];

  constructor(onFrame: (seq: number, data: Uint8Array) => void) {
    this.onFrame = onFrame;
  }

  /** Whether this browser can capture and encode voice. */
  static supported(): boolean {
    return typeof AudioEncoder !== "undefined" && !!navigator.mediaDevices?.getUserMedia && isSecureContext;
  }

  get live(): boolean {
    return this.stream !== null && !this.muted;
  }

  /** Ask for the microphone and start listening. Throws a user-facing message. */
  async start(): Promise<void> {
    if (this.stream) {
      this.muted = false;
      return;
    }
    if (!Microphone.supported()) throw new Error("This browser cannot send voice (it needs WebCodecs over HTTPS).");
    const support = await AudioEncoder.isConfigSupported(ENCODER_CONFIG);
    if (!support.supported) throw new Error("This browser cannot encode Opus voice.");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch {
      throw new Error("Microphone access was blocked. Allow it in the browser's site settings.");
    }

    const ctx = audioContext();
    workletLoaded ??= ctx.audioWorklet.addModule(
      URL.createObjectURL(new Blob([TAP_WORKLET], { type: "text/javascript" })),
    );
    await workletLoaded;

    this.encoder = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.onFrame(this.seq, data);
        this.seq = (this.seq + 1) & 0xffff;
      },
      error: (e) => console.warn("voice encoder:", e),
    });
    this.encoder.configure(ENCODER_CONFIG);

    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    this.tap = new AudioWorkletNode(ctx, "daystar-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    this.tap.port.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer>>) => this.onSamples(e.data);
    // Some browsers only run nodes that lead to the speakers; this path is silent.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.tap).connect(this.sink).connect(ctx.destination);
    this.muted = false;
  }

  /** Stop sending but keep the microphone open (instant unmute). */
  mute(): void {
    this.muted = true;
    this.level = 0;
    this.openFor = 0;
  }

  /** Release the microphone entirely (e.g. no longer a speaker). */
  stop(): void {
    this.tap?.port.close();
    this.source?.disconnect();
    this.tap?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.encoder && this.encoder.state !== "closed") this.encoder.close();
    this.stream = this.source = this.tap = this.sink = this.encoder = null;
    this.level = 0;
    this.openFor = 0;
    this.preRoll.length = 0;
  }

  private onSamples(frame: Float32Array<ArrayBuffer>): void {
    if (this.muted || !this.encoder) return;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    this.level = Math.max(rms * 6, this.level * 0.85);

    if (rms >= GATE_OPEN_RMS) {
      if (this.openFor === 0) for (const early of this.preRoll.splice(0)) this.encode(early);
      this.openFor = GATE_HANGOVER_FRAMES;
    }
    if (this.openFor > 0) {
      this.openFor--;
      this.encode(frame);
    } else {
      this.preRoll.push(frame);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
    }
  }

  private encode(frame: Float32Array<ArrayBuffer>): void {
    const data = new AudioData({
      format: "f32-planar",
      sampleRate: VOICE_SAMPLE_RATE,
      numberOfFrames: frame.length,
      numberOfChannels: 1,
      timestamp: this.frameIndex++ * VOICE_FRAME_MS * 1000,
      data: frame,
    });
    this.encoder!.encode(data);
    data.close();
  }
}
