import { VOICE_FRAME_MS, VOICE_SAMPLE_RATE } from "../../../shared/src/constants.ts";
import type { ToWorkletNode } from "./messages.ts";

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const FRAME_SAMPLES = (VOICE_SAMPLE_RATE * VOICE_FRAME_MS) / 1000;

/** Audio thread: cuts the mic signal into whole 20 ms frames and hands them to the voice worker. */
class DaystarCapture extends AudioWorkletProcessor {
  private frame = new Float32Array(FRAME_SAMPLES);
  private filled = 0;
  private out: MessagePort | null = null;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToWorkletNode>) => {
      if (e.data.t === "port") this.out = e.data.port;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let i = 0;
    while (i < input.length) {
      const n = Math.min(input.length - i, this.frame.length - this.filled);
      this.frame.set(input.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled === this.frame.length) {
        this.out?.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(FRAME_SAMPLES);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("daystar-capture", DaystarCapture);
