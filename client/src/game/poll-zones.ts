import { Container, Graphics, Text } from "pixi.js";
import { POLL_ZONE_RADIUS, pollZoneAt, pollZones, type Poll } from "../../../shared/src/poll.ts";

/** One color per answer, the same in the poll card (see ANSWER_COLORS in ui/poll.ts). */
export const ANSWER_COLORS = [0x6cb8ff, 0xff7eb6, 0x8ef08a, 0xff8c5a];
/** After the host ends a poll its planets stay, showing the result, this long. */
const RESULT_MS = 12_000;
const FADE_MS = 1_200;

interface Zone {
  ring: Graphics;
  fill: Graphics;
  label: Text;
  count: Text;
}

/**
 * The answer planets of the current poll, drawn in the world around the sun:
 * a translucent disc per answer with its text and live count. The one we are
 * in lights up; after the poll ends the winner glows until they fade.
 */
export class PollZones {
  readonly view = new Container();
  private zones: Zone[] = [];
  private poll: Poll | null = null;
  private endedAt = 0;
  private mine = -1;

  /** A poll started (or a new one replaced it). */
  show(poll: Poll): void {
    this.clear();
    this.poll = poll;
    this.endedAt = 0;
    this.view.alpha = 1;
    pollZones(poll.options.length).forEach((c, i) => {
      const color = ANSWER_COLORS[i];
      const fill = new Graphics().circle(0, 0, POLL_ZONE_RADIUS).fill({ color, alpha: 1 });
      fill.alpha = 0.08;
      const ring = new Graphics().circle(0, 0, POLL_ZONE_RADIUS).stroke({ color, width: 4, alpha: 0.7 });
      const label = new Text({
        text: poll.options[i],
        style: {
          fontFamily: "Space Grotesk, system-ui, sans-serif",
          fontSize: 34,
          fontWeight: "700",
          fill: 0xe8ecff,
          align: "center",
          wordWrap: true,
          wordWrapWidth: POLL_ZONE_RADIUS * 1.6,
        },
        resolution: 2,
      });
      // Text at the top edge, so it does not cover the players standing inside.
      label.anchor.set(0.5, 1);
      label.y = -POLL_ZONE_RADIUS - 10;
      const count = new Text({
        text: "",
        style: { fontFamily: "Space Grotesk, system-ui, sans-serif", fontSize: 52, fontWeight: "700", fill: color },
        resolution: 2,
      });
      count.anchor.set(0.5, 0);
      count.y = -POLL_ZONE_RADIUS + 14;
      const zone = new Container();
      zone.position.set(c.x, c.y);
      zone.addChild(fill, ring, label, count);
      this.view.addChild(zone);
      this.zones.push({ ring, fill, label, count });
    });
    this.setCounts(poll.counts);
  }

  setCounts(counts: number[]): void {
    if (!this.poll) return;
    this.poll.counts = counts;
    this.zones.forEach((z, i) => (z.count.text = String(counts[i] ?? 0)));
  }

  /** The host ended the poll: show the final counts, the winner glowing. */
  end(final: Poll): void {
    if (this.poll?.id !== final.id) this.show(final);
    this.poll = final;
    this.setCounts(final.counts);
    this.endedAt = performance.now();
    const best = Math.max(...final.counts);
    this.zones.forEach((z, i) => {
      const won = best > 0 && final.counts[i] === best;
      z.fill.alpha = won ? 0.3 : 0.04;
      z.ring.alpha = won ? 1 : 0.35;
    });
  }

  /** Which answer planet (x, y) is in while a poll is open, or -1. */
  zoneAt(x: number, y: number): number {
    return this.poll?.open ? pollZoneAt(x, y, this.poll.options.length) : -1;
  }

  update(now: number, selfX: number, selfY: number): void {
    if (!this.poll) return;
    if (this.endedAt > 0) {
      const left = this.endedAt + RESULT_MS - now;
      if (left <= 0) this.clear();
      else this.view.alpha = Math.min(1, left / FADE_MS);
      return;
    }
    const mine = this.zoneAt(selfX, selfY);
    if (mine === this.mine) return;
    this.mine = mine;
    this.zones.forEach((z, i) => {
      z.fill.alpha = i === mine ? 0.22 : 0.08;
      z.ring.alpha = i === mine ? 1 : 0.7;
    });
  }

  clear(): void {
    this.view.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.zones = [];
    this.poll = null;
    this.mine = -1;
  }
}
