import {
  appearanceId,
  appearanceOf,
  BODY_KINDS,
  BODY_LABELS,
  DEFAULT_APPEARANCE,
  isAppearanceId,
  PALETTE,
  type AppearanceId,
  type BodyKind,
} from "../../../shared/src/appearance.ts";
import { paintBody } from "../game/bodies.ts";

const NAME_KEY = "daystar:name";
const APPEARANCE_KEY = "daystar:appearance";

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

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** A small canvas drawing of a body, made from the same parts as in the game. */
function drawPreview(canvas: HTMLCanvasElement, kind: BodyKind, colorIndex: number): void {
  const size = 72;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.height = size * dpr;
  canvas.style.width = canvas.style.height = `${size}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  const color = PALETTE[colorIndex].color;
  const glow = ctx.createRadialGradient(c, c, 0, c, c, c);
  glow.addColorStop(0, `${hex(color)}aa`);
  glow.addColorStop(0.3, `${hex(color)}44`);
  glow.addColorStop(1, `${hex(color)}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  // Wide kinds (rings, disks, orbits) are drawn a little smaller to fit.
  const wide = kind === "ringed" || kind === "hole" || kind === "moonlet" || kind === "ufo" || kind === "pulsar";
  paintBody(ctx, kind, colorIndex, c, c, wide ? 1.05 : kind === "gas" ? 1.3 : 1.6);
}

export interface LobbyChoice {
  name: string;
  appearance: AppearanceId;
}

/**
 * Show the join form and resolve with the player's choice. Without a room id the
 * form creates a new room (whose creator becomes the host); `isHost` means this
 * browser holds the room's host key.
 * `join` should reject with a user-facing message to keep the form open.
 */
export async function runLobby(
  roomId: string | null,
  isHost: boolean,
  join: (choice: LobbyChoice) => Promise<void>,
): Promise<void> {
  const lobby = document.getElementById("lobby")!;
  const form = document.getElementById("join-form") as HTMLFormElement;
  const nameInput = document.getElementById("name-input") as HTMLInputElement;
  const kindGrid = document.getElementById("kind-grid")!;
  const colorGrid = document.getElementById("color-grid")!;
  const button = document.getElementById("join-button") as HTMLButtonElement;
  const error = document.getElementById("join-error")!;

  const note = document.getElementById("lobby-note")!;
  document.getElementById("room-line")!.hidden = roomId === null;
  document.getElementById("lobby-room")!.textContent = roomId ?? "";
  if (roomId === null) {
    button.textContent = "Create a room";
    note.textContent = "You will host it: you become the sun at the center, and choose who may speak.";
    note.hidden = false;
  } else if (isHost) {
    button.textContent = "Join as host";
    note.textContent = "You created this room, so you are its host.";
    note.hidden = false;
  }
  nameInput.value = load(NAME_KEY) ?? "";

  const stored = Number(load(APPEARANCE_KEY));
  let { kind, colorIndex } = appearanceOf(isAppearanceId(stored) ? stored : DEFAULT_APPEARANCE);

  const kindButtons = BODY_KINDS.map((k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kind";
    b.setAttribute("role", "radio");
    const canvas = document.createElement("canvas");
    b.append(canvas, BODY_LABELS[k]);
    b.addEventListener("click", () => {
      kind = k;
      refresh();
    });
    return { kind: k, button: b, canvas };
  });
  kindGrid.replaceChildren(...kindButtons.map((k) => k.button));

  const swatches = PALETTE.map((p, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", p.name);
    b.title = p.name;
    b.style.setProperty("--swatch", hex(p.color));
    b.addEventListener("click", () => {
      colorIndex = i;
      refresh();
    });
    return b;
  });
  colorGrid.replaceChildren(...swatches);

  function refresh(): void {
    for (const k of kindButtons) {
      k.button.setAttribute("aria-checked", String(k.kind === kind));
      drawPreview(k.canvas, k.kind, colorIndex);
    }
    swatches.forEach((s, i) => s.setAttribute("aria-checked", String(i === colorIndex)));
  }
  refresh();
  nameInput.focus();

  return new Promise((resolve) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      const appearance = appearanceId(kind, colorIndex);
      save(NAME_KEY, name);
      save(APPEARANCE_KEY, String(appearance));
      button.disabled = true;
      error.textContent = "";
      try {
        await join({ name, appearance });
        lobby.hidden = true;
        resolve();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err);
        button.disabled = false;
      }
    });
  });
}
