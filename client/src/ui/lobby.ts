import { CHARACTERS, CHARACTER_IDS, type CharacterId } from "../../../shared/src/characters.ts";

const NAME_KEY = "cute-meeting:name";
const CHARACTER_KEY = "cute-meeting:character";

interface SheetData {
  animations: Record<string, string[]>;
  frames: Record<string, { frame: { w: number; h: number } }>;
  meta: { size: { w: number; h: number } };
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: remembering the choice is optional.
  }
}

/** Animated CSS preview of a character's south-facing idle (run on hover). */
async function buildPreview(id: CharacterId): Promise<HTMLElement> {
  const data: SheetData = await fetch(`/assets/characters/${id}.json`).then((r) => r.json());
  const scale = CHARACTERS[id].scale;
  const first = data.frames[data.animations.idle_south[0]].frame;
  const w = first.w * scale;
  const h = first.h * scale;

  const box = document.createElement("div");
  box.className = "sprite-preview";
  const sprite = document.createElement("div");
  sprite.style.width = `${w}px`;
  sprite.style.height = `${h}px`;
  sprite.style.backgroundImage = `url(/assets/characters/${id}.png)`;
  sprite.style.backgroundSize = `${data.meta.size.w * scale}px ${data.meta.size.h * scale}px`;
  sprite.style.setProperty("--frame-w", String(w));

  // Sheet rows: idle south, west, east, north, then run in the same order.
  const show = (anim: "idle_south" | "run_south", row: number, fps: number) => {
    const frames = data.animations[anim].length;
    sprite.style.backgroundPositionY = `${-row * h}px`;
    sprite.style.setProperty("--frames", String(frames));
    sprite.style.setProperty("--duration", `${frames / fps}s`);
  };
  show("idle_south", 0, CHARACTERS[id].idleFps);
  box.addEventListener("pointerenter", () => show("run_south", 4, CHARACTERS[id].runFps));
  box.addEventListener("pointerleave", () => show("idle_south", 0, CHARACTERS[id].idleFps));

  box.appendChild(sprite);
  return box;
}

export interface LobbyChoice {
  name: string;
  character: CharacterId;
}

/**
 * Show the join form and resolve with the player's choice.
 * `join` should reject with a user-facing message to keep the form open.
 */
export async function runLobby(roomId: string, join: (choice: LobbyChoice) => Promise<void>): Promise<void> {
  const lobby = document.getElementById("lobby")!;
  const form = document.getElementById("join-form") as HTMLFormElement;
  const nameInput = document.getElementById("name-input") as HTMLInputElement;
  const grid = document.getElementById("character-grid")!;
  const button = document.getElementById("join-button") as HTMLButtonElement;
  const error = document.getElementById("join-error")!;

  document.getElementById("lobby-room")!.textContent = roomId;
  nameInput.value = load(NAME_KEY) ?? "";

  const stored = load(CHARACTER_KEY);
  let selected: CharacterId = CHARACTER_IDS.find((id) => id === stored) ?? "rabbit_white";

  const previews = await Promise.all(CHARACTER_IDS.map(buildPreview));
  const buttons = CHARACTER_IDS.map((id, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "character";
    b.setAttribute("role", "radio");
    b.append(previews[i], CHARACTERS[id].label);
    b.addEventListener("click", () => {
      selected = id;
      buttons.forEach((other, j) => other.setAttribute("aria-checked", String(CHARACTER_IDS[j] === id)));
    });
    b.setAttribute("aria-checked", String(id === selected));
    return b;
  });
  grid.replaceChildren(...buttons);
  nameInput.focus();

  return new Promise((resolve) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      save(NAME_KEY, name);
      save(CHARACTER_KEY, selected);
      button.disabled = true;
      error.textContent = "";
      try {
        await join({ name, character: selected });
        lobby.hidden = true;
        resolve();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err);
        button.disabled = false;
      }
    });
  });
}
