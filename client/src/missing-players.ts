import { MAX_WHO_IDS } from "../../shared/src/protocol.ts";

/** Ask about an id again if the answer has not come this long after asking. */
const RETRY_MS = 2_000;
/** Ids seen within this long go out together. */
const BATCH_MS = 100;

/**
 * Players we see in snapshots but never heard join. The server drops frames to
 * a socket that stops reading for a while (a phone in the background, a weak
 * network), and the join may have been in one of them: ask the server who they
 * are ("who"), a batch at a time, and again if no answer comes.
 */
export class MissingPlayers {
  private readonly asked = new Map<number, number>();
  private readonly queued = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly ask: (ids: number[]) => void;

  constructor(ask: (ids: number[]) => void) {
    this.ask = ask;
  }

  /** A snapshot mentions `id` and we do not know that player. */
  saw(id: number, now = performance.now()): void {
    const at = this.asked.get(id);
    if (at !== undefined && now - at < RETRY_MS) return;
    this.queued.add(id);
    this.timer ??= setTimeout(() => this.flush(), BATCH_MS);
  }

  /** We know the player now (an answer, or a join after all). */
  found(id: number): void {
    this.asked.delete(id);
    this.queued.delete(id);
  }

  /** A fresh welcome: everything is known again. */
  reset(): void {
    this.asked.clear();
    this.queued.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private flush(): void {
    this.timer = null;
    const ids = [...this.queued].slice(0, MAX_WHO_IDS);
    if (ids.length === 0) return;
    const now = performance.now();
    for (const id of ids) {
      this.queued.delete(id);
      this.asked.set(id, now);
    }
    this.ask(ids);
    // More than one request's worth: the rest goes after the server's rate limit.
    if (this.queued.size > 0) this.timer = setTimeout(() => this.flush(), 300);
  }
}
