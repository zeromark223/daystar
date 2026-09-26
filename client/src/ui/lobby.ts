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

/** A small canvas drawing of a body, matching the in-game look closely enough. */
function drawPreview(canvas: HTMLCanvasElement, kind: BodyKind, color: number): void {
  const size = 96;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.height = size * dpr;
  canvas.style.width = canvas.style.height = `${size}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  const glow = ctx.createRadialGradient(c, c, 0, c, c, c);
  glow.addColorStop(0, hex(color));
  glow.addColorStop(0.3, `${hex(color)}66`);
  glow.addColorStop(1, `${hex(color)}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  if (kind === "star") {
    ctx.fillStyle = "#ffffffdd";
    ctx.beginPath();
    ctx.moveTo(c, c - 26);
    ctx.lineTo(c + 3, c);
    ctx.lineTo(c, c + 26);
    ctx.lineTo(c - 3, c);
    ctx.closePath();
    ctx.moveTo(c - 26, c);
    ctx.lineTo(c, c + 3);
    ctx.lineTo(c + 26, c);
    ctx.lineTo(c, c - 3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(c, c, 6, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const r = kind === "planet" ? 15 : 13;
  if (kind === "ringed") {
    ctx.strokeStyle = "#ffffffaa";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(c, c, r * 2.3, r * 0.75, 0, Math.PI, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = hex(color);
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#00000047";
  ctx.beginPath();
  ctx.arc(c + r * 0.35, c + r * 0.3, r * 0.92, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff5a";
  ctx.beginPath();
  ctx.arc(c - r * 0.35, c - r * 0.35, r * 0.35, 0, Math.PI * 2);
  ctx.fill();
  if (kind === "ringed") {
    ctx.strokeStyle = "#ffffffaa";
    ctx.beginPath();
    ctx.ellipse(c, c, r * 2.3, r * 0.75, 0, 0, Math.PI);
    ctx.stroke();
  }
}

export interface LobbyChoice {
  name: string;
  appearance: AppearanceId;
}

/**
 * Show the join form and resolve with the player's choice.
 * `join` should reject with a user-facing message to keep the form open.
 */
export async function runLobby(roomId: string, join: (choice: LobbyChoice) => Promise<void>): Promise<void> {
  const lobby = document.getElementById("lobby")!;
  const form = document.getElementById("join-form") as HTMLFormElement;
  const nameInput = document.getElementById("name-input") as HTMLInputElement;
  const kindGrid = document.getElementById("kind-grid")!;
  const colorGrid = document.getElementById("color-grid")!;
  const button = document.getElementById("join-button") as HTMLButtonElement;
  const error = document.getElementById("join-error")!;

  document.getElementById("lobby-room")!.textContent = roomId;
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
    const color = PALETTE[colorIndex].color;
    for (const k of kindButtons) {
      k.button.setAttribute("aria-checked", String(k.kind === kind));
      drawPreview(k.canvas, k.kind, color);
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
