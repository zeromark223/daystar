/**
 * A minimal WebSocket client over Bun.connect, for load-test bots that only count
 * what they receive. Bun's WebSocket client allocates a MessageEvent and an
 * ArrayBuffer for every frame and calls into JS through the event machinery; at
 * tens of thousands of bots that cost more CPU than the server spent sending.
 * Here a received chunk is parsed in place and each frame is handed over as
 * (chunk, start, end): no allocation unless the caller copies it.
 *
 * Only what the bots need: ws:// (no TLS), binary frames, frames under 64 KiB
 * sent, fragments, ping/pong and close. Client frames are masked with a zero key,
 * which the protocol allows (the mask bit must be set; the key may be anything).
 */
import type { Socket } from "bun";

export interface BotSocket {
  readonly readyState: number;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const HEADER_END = new Uint8Array([13, 10, 13, 10]);

export class RawWebSocket implements BotSocket {
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  /** One complete message: bytes [start, end) of `chunk`, valid only during the call. */
  onframe: ((chunk: Uint8Array, start: number, end: number) => void) | null = null;
  onclose: ((code: number) => void) | null = null;
  onerror: (() => void) | null = null;

  private sock: Socket<undefined> | null = null;
  private handshaking = true;
  /** Bytes of an incomplete header or frame, carried over to the next chunk. */
  private rest: Uint8Array | null = null;
  /** A fragmented message being put together. */
  private fragments: Uint8Array[] | null = null;
  /** Writes the socket did not take yet (sent on drain). */
  private out: Uint8Array[] = [];
  private closeCode = 1006;
  private closeWhenOpen = false;

  constructor(url: string) {
    const u = new URL(url);
    if (u.protocol !== "ws:") throw new Error(`RawWebSocket: only ws:// URLs (${url})`);
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
    const request =
      `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    Bun.connect({
      hostname: u.hostname,
      port: Number(u.port || 80),
      socket: {
        open: (s) => {
          this.sock = s;
          // Closed (e.g. join timeout) before the connection opened.
          if (this.closeWhenOpen) return void s.end();
          this.write(new TextEncoder().encode(request));
        },
        data: (_s, chunk) => this.receive(chunk),
        drain: () => this.flush(),
        end: (s) => {
          s.end();
        },
        close: () => this.finish(),
        error: () => this.onerror?.(),
        connectError: () => {
          this.onerror?.();
          this.finish();
        },
      },
    }).catch(() => {
      this.onerror?.();
      this.finish();
    });
  }

  send(data: Uint8Array<ArrayBuffer>): void {
    if (this.readyState !== OPEN) return;
    const n = data.byteLength;
    if (n > 0xffff) throw new Error("RawWebSocket: frames over 64 KiB are not supported");
    const head = n < 126 ? 6 : 8;
    const frame = new Uint8Array(head + n);
    frame[0] = 0x82; // FIN, binary
    if (n < 126) frame[1] = 0x80 | n;
    else {
      frame[1] = 0x80 | 126;
      frame[2] = n >> 8;
      frame[3] = n & 0xff;
    }
    // Mask key: the 4 zero bytes already there, so the payload goes as is.
    frame.set(data, head);
    this.write(frame);
  }

  close(): void {
    if (this.readyState >= CLOSING) return;
    if (!this.sock || this.readyState === CONNECTING) {
      this.readyState = CLOSING;
      this.closeWhenOpen = true;
      this.sock?.end();
      return;
    }
    this.readyState = CLOSING;
    this.write(new Uint8Array([0x88, 0x82, 0, 0, 0, 0, 0x03, 0xe8])); // close, 1000
    this.sock.end();
  }

  private write(bytes: Uint8Array): void {
    if (!this.sock) return;
    if (this.out.length) {
      this.out.push(bytes);
      return;
    }
    const n = this.sock.write(bytes);
    if (n < bytes.byteLength) this.out.push(bytes.subarray(Math.max(0, n)));
  }

  private flush(): void {
    while (this.out.length && this.sock) {
      const bytes = this.out[0];
      const n = this.sock.write(bytes);
      if (n < bytes.byteLength) {
        this.out[0] = bytes.subarray(Math.max(0, n));
        return;
      }
      this.out.shift();
    }
  }

  private finish(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.sock = null;
    this.out = [];
    this.onclose?.(this.closeCode);
  }

  private receive(chunk: Uint8Array): void {
    let b = chunk;
    if (this.rest) {
      b = new Uint8Array(this.rest.byteLength + chunk.byteLength);
      b.set(this.rest);
      b.set(chunk, this.rest.byteLength);
      this.rest = null;
    }
    let o = 0;
    if (this.handshaking) {
      const end = indexOf(b, HEADER_END);
      if (end < 0) {
        this.keep(b, 0);
        return;
      }
      // "HTTP/1.1 101"
      if (b[9] !== 0x31 || b[10] !== 0x30 || b[11] !== 0x31) {
        this.onerror?.();
        this.sock?.end();
        return;
      }
      this.handshaking = false;
      o = end + 4;
      if (this.closeWhenOpen) {
        this.sock?.end();
        return;
      }
      this.readyState = OPEN;
      this.onopen?.();
    }
    const n = b.byteLength;
    while (n - o >= 2) {
      const b0 = b[o];
      const b1 = b[o + 1];
      let len = b1 & 0x7f;
      let head = 2;
      if (len === 126) {
        if (n - o < 4) break;
        len = (b[o + 2] << 8) | b[o + 3];
        head = 4;
      } else if (len === 127) {
        if (n - o < 10) break;
        len = b[o + 6] * 0x1000000 + ((b[o + 7] << 16) | (b[o + 8] << 8) | b[o + 9]);
        head = 10;
      }
      if (b1 & 0x80) head += 4; // servers do not mask; skip a key if one is there
      if (n - o < head + len) break;
      const start = o + head;
      const end = start + len;
      o = end;
      const op = b0 & 0x0f;
      const fin = (b0 & 0x80) !== 0;
      if (op === 0x1 || op === 0x2) {
        if (fin) this.onframe?.(b, start, end);
        else this.fragments = [copy(b, start, end)];
      } else if (op === 0x0) {
        if (!this.fragments) continue;
        this.fragments.push(copy(b, start, end));
        if (fin) {
          const whole = concat(this.fragments);
          this.fragments = null;
          this.onframe?.(whole, 0, whole.byteLength);
        }
      } else if (op === 0x8) {
        this.closeCode = len >= 2 ? (b[start] << 8) | b[start + 1] : 1005;
        if (this.readyState === OPEN) {
          this.readyState = CLOSING;
          this.write(new Uint8Array([0x88, 0x80, 0, 0, 0, 0]));
        }
        this.sock?.end();
        return;
      } else if (op === 0x9 && this.readyState === OPEN && len <= 125) {
        const pong = new Uint8Array(6 + len);
        pong[0] = 0x8a;
        pong[1] = 0x80 | len;
        pong.set(b.subarray(start, end), 6);
        this.write(pong);
      }
      if (this.readyState !== OPEN) return;
    }
    if (o < n) this.keep(b, o);
  }

  /** Copy the tail: the chunk's memory is not ours after the callback. */
  private keep(b: Uint8Array, from: number): void {
    this.rest = copy(b, from, b.byteLength);
  }
}

/** A copy of bytes [start, end) (Buffer's slice would share the chunk's memory). */
function copy(b: Uint8Array, start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start);
  out.set(b.subarray(start, end));
  return out;
}

function indexOf(b: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= b.length; i++) {
    for (let j = 0; j < needle.length; j++) if (b[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
