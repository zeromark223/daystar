import { readFileSync } from "node:fs";

/**
 * Opus packets from an Ogg Opus file (RFC 7845), without the two header packets.
 * The load test's speakers send these as their voice frames, so a real client
 * joining the room hears actual speech.
 */
export function readOpusPackets(path: string): Uint8Array[] {
  const bytes = readFileSync(path);
  const packets: Uint8Array[] = [];
  let partial: number[] = [];
  let pos = 0;
  while (pos + 27 <= bytes.length) {
    if (bytes.toString("latin1", pos, pos + 4) !== "OggS") throw new Error(`${path}: not an Ogg file`);
    const segments = bytes[pos + 26];
    const table = bytes.subarray(pos + 27, pos + 27 + segments);
    let body = pos + 27 + segments;
    for (const size of table) {
      for (let i = 0; i < size; i++) partial.push(bytes[body + i]);
      body += size;
      // A lacing value below 255 ends the packet; 255 means it continues.
      if (size < 255) {
        packets.push(Uint8Array.from(partial));
        partial = [];
      }
    }
    pos = body;
  }
  const [head, tags, ...audio] = packets;
  const text = (p: Uint8Array | undefined) => (p ? new TextDecoder().decode(p.subarray(0, 8)) : "");
  if (text(head) !== "OpusHead" || text(tags) !== "OpusTags") throw new Error(`${path}: not an Ogg Opus file`);
  return audio;
}
