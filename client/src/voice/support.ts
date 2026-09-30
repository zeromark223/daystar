/**
 * Why voice cannot work in this page, as a sentence for the user, or null when it
 * can. WebCodecs, AudioWorklet and the microphone all exist only in secure
 * contexts: a page opened over plain http:// by IP address (e.g. a phone on the
 * LAN) has none of them.
 */
export function voiceProblem(direction: "play" | "send"): string | null {
  if (!isSecureContext) return "Voice needs a secure connection: open this page over https:// (or on localhost).";
  const missing: string[] = [];
  const codec = direction === "play" ? typeof AudioDecoder : typeof AudioEncoder;
  if (codec === "undefined") missing.push("WebCodecs audio");
  if (typeof AudioWorkletNode === "undefined") missing.push("AudioWorklet");
  if (direction === "send" && !navigator.mediaDevices?.getUserMedia) missing.push("microphone access");
  if (missing.length === 0) return null;
  return `This browser cannot ${direction} voice (no ${missing.join(" or ")}). Voice works in Chrome or Safari on phones, and Chrome, Edge or Firefox on computers.`;
}
