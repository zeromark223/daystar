export interface SettingsActions {
  replayTutorial(): void;
}

/** The ⚙ button and its small panel. For now it holds the tutorial replay. */
export class SettingsPanel {
  private readonly button = document.getElementById("settings-button") as HTMLButtonElement;
  private readonly panel = document.getElementById("settings")!;

  constructor(actions: SettingsActions) {
    this.button.addEventListener("click", () => this.setOpen(this.panel.hidden !== false));
    document.getElementById("replay-tutorial")!.addEventListener("click", () => {
      this.setOpen(false);
      actions.replayTutorial();
    });
    window.addEventListener("pointerdown", (e) => {
      const t = e.target as Node;
      if (!this.panel.hidden && !this.panel.contains(t) && !this.button.contains(t)) this.setOpen(false);
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.setOpen(false);
    });
  }

  private setOpen(open: boolean): void {
    this.panel.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
  }
}
