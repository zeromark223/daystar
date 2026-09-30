/**
 * Adaptive playout delay for one speaker (seconds, AudioContext time).
 *
 * Frames arrive in bursts (one server frame per 50-100 ms) with network jitter
 * on top, and TCP turns loss into stalls. Each speaker is played `target` behind
 * the arrival of the first frame of a talk spurt:
 * - an underrun in the middle of a spurt (the queue ran dry) raises the target;
 * - when the queue never got close to empty for a while, the target is lowered.
 * Changes apply at the start of the next spurt (the voice gate leaves pauses
 * between sentences), so speech is never stretched or cut to resize the buffer.
 */
export const PLAYOUT = {
  initial: 0.15,
  min: 0.08,
  max: 0.4,
  /** Added to the target on each underrun. */
  stepUp: 0.04,
  /** Most the target shrinks per relax window. */
  stepDown: 0.01,
  /** Queue kept in reserve before shrinking: bursts arrive late by this much without harm. */
  safety: 0.05,
  /** A queue shorter than this when a frame arrives counts as an underrun. */
  underrun: 0.02,
  relaxEveryS: 8,
  /** Never queue more than this (e.g. a backlog after a stall): newer frames are dropped. */
  maxLead: 1,
} as const;

export class PlayoutClock {
  target: number = PLAYOUT.initial;
  underruns = 0;
  private playhead = -Infinity;
  /** Smallest queue seen when a frame arrived since the last adjustment. */
  private minLead = Infinity;
  private windowStart: number | null = null;

  /**
   * Start time for a frame of `duration` s arriving at `now`, or null to drop it
   * (too much is queued already). `continuous` is false for the first frame of a
   * talk spurt (its seq does not follow the previous frame's).
   */
  schedule(now: number, duration: number, continuous: boolean): number | null {
    this.windowStart ??= now;
    const lead = this.playhead - now;
    if (lead > PLAYOUT.maxLead) return null;
    if (!continuous) {
      this.relax(now);
      if (lead < this.target) this.playhead = now + this.target;
    } else if (lead < PLAYOUT.underrun) {
      this.target = Math.min(PLAYOUT.max, this.target + PLAYOUT.stepUp);
      this.underruns++;
      this.minLead = Infinity;
      this.windowStart = now;
      this.playhead = now + this.target;
    } else {
      this.minLead = Math.min(this.minLead, lead);
    }
    const start = this.playhead;
    this.playhead += duration;
    return start;
  }

  private relax(now: number): void {
    if (now - this.windowStart! < PLAYOUT.relaxEveryS) return;
    if (this.minLead !== Infinity && this.minLead > PLAYOUT.safety) {
      this.target = Math.max(PLAYOUT.min, this.target - Math.min(PLAYOUT.stepDown, this.minLead - PLAYOUT.safety));
    }
    this.minLead = Infinity;
    this.windowStart = now;
  }
}
