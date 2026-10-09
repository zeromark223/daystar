export interface SettingsActions {
  replayTutorial(): void;
  orbitNames(shown: boolean): void;
}

const ORBIT_NAMES_KEY = "daystar:orbit-names";

/** The ⚙ button and its panel: replay the tutorial, names in orbit (remembered in this browser). */
export class SettingsPanel {
  private readonly button = document.getElementById("settings-button") as HTMLButtonElement;
  private readonly panel = document.getElementById("settings")!;

  constructor(actions: SettingsActions) {
    this.button.addEventListener("click", () => this.setOpen(this.panel.hidden !== false));
    document.getElementById("replay-tutorial")!.addEventListener("click", () => {
      this.setOpen(false);
      actions.replayTutorial();
    });
    const names = document.getElementById("orbit-names") as HTMLInputElement;
    try {
      names.checked = localStorage.getItem(ORBIT_NAMES_KEY) === "1";
    } catch {
      // Storage blocked: names stay hidden by default.
    }
    actions.orbitNames(names.checked);
    names.addEventListener("change", () => {
      actions.orbitNames(names.checked);
      try {
        localStorage.setItem(ORBIT_NAMES_KEY, names.checked ? "1" : "0");
      } catch {
        // Not remembered; it still applies now.
      }
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
