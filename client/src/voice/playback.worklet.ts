import type { PlaybackStats, ToPlayback, ToWorkletNode } from "./messages.ts";
import { PlayoutClock } from "./playout.ts";

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;
declare const currentTime: number;
declare const currentFrame: number;

/** Stats to the main thread every ~50 ms (19 render quanta of 128 samples at 48 kHz). */
const STATS_EVERY_QUANTA = 19;
/** Speaking level falls off with this time constant after the voice stops. */
const LEVEL_DECAY_S = 0.18;

interface Chunk {
  /** First sample, in the context's frame count. */
  start: number;
  data: Float32Array;
}

interface Speaker {
  clock: PlayoutClock;
  /** Scheduled audio, in order and never overlapping (the playhead only moves forward). */
  chunks: Chunk[];
  level: number;
}

/**
 * Audio thread: receives decoded frames from the voice worker, schedules each
 * speaker with its own adaptive delay (playout.ts) and mixes them into one output.
 * Nothing here waits for the main thread.
 */
class DaystarPlayback extends AudioWorkletProcessor {
  private readonly speakers = new Map<number, Speaker>();
  private played = 0;
  private quanta = 0;
  private awaitingAck = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToWorkletNode>) => {
      const m = e.data;
      if (m.t === "port") m.port.onmessage = (ev: MessageEvent<ToPlayback>) => this.receive(ev.data);
      else this.awaitingAck = false;
    };
  }

  private receive(m: ToPlayback): void {
    if (m.t === "remove") {
      this.speakers.delete(m.id);
      return;
    }
    if (m.t === "clear") {
      this.speakers.clear();
      return;
    }
    let s = this.speakers.get(m.id);
    if (!s) {
      s = { clock: new PlayoutClock(), chunks: [], level: 0 };
      this.speakers.set(m.id, s);
    }
    const start = s.clock.schedule(currentTime, m.samples.length / sampleRate, m.continuous);
    if (start === null) return; // too much queued already
    s.chunks.push({ start: Math.round(start * sampleRate), data: m.samples });
    this.played++;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0][0];
    out.fill(0);
    const t0 = currentFrame;
    const end = t0 + out.length;
    const decay = Math.exp(-out.length / sampleRate / LEVEL_DECAY_S);
    for (const s of this.speakers.values()) {
      let sum = 0;
      let finished = 0;
      for (const c of s.chunks) {
        if (c.start >= end) break;
        const from = Math.max(t0, c.start);
        const to = Math.min(end, c.start + c.data.length);
        for (let t = from; t < to; t++) {
          const v = c.data[t - c.start];
          out[t - t0] += v;
          sum += v * v;
        }
        if (c.start + c.data.length <= end) finished++;
      }
      if (finished > 0) s.chunks.splice(0, finished);
      s.level = Math.max(Math.sqrt(sum / out.length) * 6, s.level * decay);
    }
    if (++this.quanta % STATS_EVERY_QUANTA === 0 && !this.awaitingAck) {
      const stats: PlaybackStats = {
        t: "stats",
        played: this.played,
        speakers: [...this.speakers].map(([id, s]) => [id, s.level, Math.round(s.clock.target * 1000)]),
      };
      this.port.postMessage(stats);
      this.awaitingAck = true;
    }
    return true;
  }
}

registerProcessor("daystar-playback", DaystarPlayback);
