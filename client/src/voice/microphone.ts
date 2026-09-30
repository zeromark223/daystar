import { VOICE_BITRATE, VOICE_FRAME_MS, VOICE_SAMPLE_RATE } from "../../../shared/src/constants.ts";
import { audioContext } from "./audio.ts";
import captureUrl from "./capture.worklet.ts?worker&url";
import { listenEncoded, post } from "./engine.ts";
import type { ToWorkletNode } from "./messages.ts";
import { voiceProblem } from "./support.ts";

let captureLoaded: Promise<void> | null = null;

/**
 * The local microphone, for the host and speakers: echo-cancelled mic audio goes
 * from a capture worklet straight to the voice worker, which gates silence and
 * encodes Opus; encoded frames come back here in batches for the WebSocket.
 */
export class Microphone {
  /** Smoothed input level, 0..1, for the speaking glow (0 while muted). */
  level = 0;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private muted = false;

  constructor(onFrame: (seq: number, data: Uint8Array) => void) {
    listenEncoded((msg) => {
      this.level = this.live ? msg.level : 0;
      for (const f of msg.frames) onFrame(f.seq, f.data);
    });
  }

  /** Whether this browser can capture and encode voice. */
  static supported(): boolean {
    return voiceProblem("send") === null;
  }

  get live(): boolean {
    return this.stream !== null && !this.muted;
  }

  /** Ask for the microphone and start sending. Throws a user-facing message. */
  async start(): Promise<void> {
    if (this.stream) {
      this.setMuted(false);
      return;
    }
    const problem = voiceProblem("send");
    if (problem) throw new Error(problem);
    const support = await AudioEncoder.isConfigSupported({
      codec: "opus",
      sampleRate: VOICE_SAMPLE_RATE,
      numberOfChannels: 1,
      bitrate: VOICE_BITRATE,
      opus: { frameDuration: VOICE_FRAME_MS * 1000 },
    });
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
    captureLoaded ??= ctx.audioWorklet.addModule(captureUrl);
    await captureLoaded;

    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(ctx, "daystar-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    const channel = new MessageChannel();
    this.node.port.postMessage({ t: "port", port: channel.port1 } satisfies ToWorkletNode, [channel.port1]);
    post({ t: "mic", capture: channel.port2 }, [channel.port2]);
    // Some browsers only run nodes that lead to the speakers; this path is silent.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node).connect(this.sink).connect(ctx.destination);
    this.setMuted(false);
  }

  /** Stop sending but keep the microphone open (instant unmute). */
  mute(): void {
    this.setMuted(true);
  }

  /** Release the microphone entirely (e.g. no longer a speaker). */
  stop(): void {
    if (!this.stream) return;
    post({ t: "mic", capture: null });
    this.source?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = this.source = this.node = this.sink = null;
    this.level = 0;
  }

  private setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.level = 0;
    post({ t: "mute", muted });
  }
}
