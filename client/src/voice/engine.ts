import type { FromWorker, ToWorker } from "./messages.ts";
import VoiceWorker from "./voice.worker.ts?worker";

let worker: Worker | null = null;
let onEncoded: ((msg: FromWorker) => void) | null = null;

/** The page's one voice worker (encode and decode), created on first use. */
export function voiceWorker(): Worker {
  if (!worker) {
    worker = new VoiceWorker();
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      onEncoded?.(e.data);
      post({ t: "ack" });
    };
  }
  return worker;
}

export function post(msg: ToWorker, transfer: Transferable[] = []): void {
  voiceWorker().postMessage(msg, transfer);
}

/** Where encoded microphone batches go (one microphone per page). */
export function listenEncoded(listener: ((msg: FromWorker) => void) | null): void {
  onEncoded = listener;
}
