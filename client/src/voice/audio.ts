import { VOICE_SAMPLE_RATE } from "../../../shared/src/constants.ts";

let context: AudioContext | null = null;

/**
 * The page's one AudioContext, at the voice sample rate (the browser resamples
 * the microphone and the speakers). Browsers only let audio start after a user
 * gesture, so call unlockAudio() from a click handler before anything plays.
 */
export function audioContext(): AudioContext {
  context ??= new AudioContext({ sampleRate: VOICE_SAMPLE_RATE, latencyHint: "interactive" });
  return context;
}

/** Call synchronously inside a click or submit handler. */
export function unlockAudio(): void {
  void audioContext()
    .resume()
    .catch(() => {});
}
