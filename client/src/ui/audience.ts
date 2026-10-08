import { REACTIONS } from "../../../shared/src/audience.ts";

export interface AudienceActions {
  react(kind: number): void;
  hand(up: boolean): void;
}

function isTyping(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/**
 * The reaction bar (also keys 1-6) and the raise-hand button (also H). The
 * hand's state comes from the server, so the button shows what everyone sees.
 */
export class AudienceBar {
  private readonly bar = document.getElementById("audience")!;
  private readonly handButton: HTMLButtonElement;
  private handUp = false;

  constructor(actions: AudienceActions) {
    const buttons = REACTIONS.map((r, kind) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "react";
      b.textContent = r.emoji;
      b.title = `${r.label} (${kind + 1})`;
      b.setAttribute("aria-label", r.label);
      b.addEventListener("click", () => {
        actions.react(kind);
        b.classList.remove("pop");
        void b.offsetWidth; // restart the animation
        b.classList.add("pop");
      });
      return b;
    });
    this.handButton = document.createElement("button");
    this.handButton.type = "button";
    this.handButton.className = "hand";
    this.handButton.title = "Raise your hand to ask the host for the floor (H)";
    this.handButton.addEventListener("click", () => actions.hand(!this.handUp));
    this.bar.replaceChildren(...buttons, this.handButton);
    this.setHand(false);

    window.addEventListener("keydown", (e) => {
      if (isTyping() || e.repeat || e.ctrlKey || e.metaKey || e.altKey || this.bar.hidden) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= REACTIONS.length) buttons[n - 1].click();
      else if (e.code === "KeyH" && !this.handButton.hidden) this.handButton.click();
    });
  }

  show(): void {
    this.bar.hidden = false;
  }

  /** Only guests ask for the floor; the host and speakers have it. */
  setCanRaise(can: boolean): void {
    this.handButton.hidden = !can;
  }

  setHand(up: boolean): void {
    this.handUp = up;
    this.handButton.setAttribute("aria-pressed", String(up));
    this.handButton.textContent = up ? "✋ Lower hand" : "✋ Raise hand";
  }
}
