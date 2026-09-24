const KEYMAP: Record<string, "up" | "down" | "left" | "right"> = {
  KeyW: "up",
  ArrowUp: "up",
  KeyS: "down",
  ArrowDown: "down",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
};

function isTyping(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/** Keyboard movement state; ignored while a text field has focus. */
export class KeyboardInput {
  private readonly held = new Set<string>();

  constructor() {
    window.addEventListener("keydown", (e) => {
      const key = KEYMAP[e.code];
      if (!key || isTyping()) return;
      this.held.add(key);
      e.preventDefault();
    });
    window.addEventListener("keyup", (e) => {
      const key = KEYMAP[e.code];
      if (key) this.held.delete(key);
    });
    window.addEventListener("blur", () => this.held.clear());
  }

  /** Unnormalized direction vector from the currently held keys. */
  vector(): { x: number; y: number } {
    if (isTyping()) this.held.clear();
    return {
      x: (this.held.has("right") ? 1 : 0) - (this.held.has("left") ? 1 : 0),
      y: (this.held.has("down") ? 1 : 0) - (this.held.has("up") ? 1 : 0),
    };
  }
}
