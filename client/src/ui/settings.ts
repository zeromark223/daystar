import type { GatherStyle } from "../game/game.ts";

export interface SettingsActions {
  replayTutorial(): void;
  orbitNames(shown: boolean): void;
  gatherStyle(style: GatherStyle): void;
}

const ORBIT_NAMES_KEY = "daystar:orbit-names";
/**
 * Only an explicit choice is stored. (A new key: the A/B test stored random
 * picks under "daystar:gather-effect", and those should not stick.)
 */
const GATHER_KEY = "daystar:gather-style";
const STYLES: GatherStyle[] = ["corona", "flight"];
const isStyle = (v: unknown): v is GatherStyle => STYLES.includes(v as GatherStyle);
export const DEFAULT_GATHER_STYLE: GatherStyle = "corona";

/** ?gather=corona|flight wins, then what this browser chose in Settings, else Corona. */
function initialGatherStyle(): GatherStyle {
  const forced = new URLSearchParams(location.search).get("gather");
  if (isStyle(forced)) return forced;
  try {
    const saved = localStorage.getItem(GATHER_KEY);
    if (isStyle(saved)) return saved;
  } catch {
    // Storage blocked: the default.
  }
  return DEFAULT_GATHER_STYLE;
}

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
    const effect = document.getElementById("gather-effect") as HTMLSelectElement;
    effect.value = initialGatherStyle();
    actions.gatherStyle(effect.value as GatherStyle);
    effect.addEventListener("change", () => {
      actions.gatherStyle(effect.value as GatherStyle);
      try {
        localStorage.setItem(GATHER_KEY, effect.value);
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
