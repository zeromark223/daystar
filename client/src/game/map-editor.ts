import { Container, Graphics, type FederatedPointerEvent } from "pixi.js";
import type { CollisionMap } from "../../../shared/src/collision.ts";
import type { CollisionOverlay } from "./collision-overlay.ts";

type Tool = "draw" | "erase";

interface CellChange {
  cx: number;
  cy: number;
  walkable: boolean;
}

const BRUSH_SIZES = [1, 2, 3, 5, 8];
const MAX_UNDO = 100;

/**
 * Collision editor enabled with ?edit. "Draw" marks cells blocked, "Erase"
 * makes them walkable; edits apply locally at once and persist on Save.
 * With no tool selected the game behaves normally (tap to move).
 */
export class MapEditor {
  private readonly map: CollisionMap;
  private readonly overlay: CollisionOverlay;
  private readonly world: Container;
  private readonly cursor = new Graphics();
  private tool: Tool | null = null;
  private brush = 2;
  private stroke: CellChange[] | null = null;
  private lastCell: { cx: number; cy: number } | null = null;
  private readonly undoStack: CellChange[][] = [];
  private unsaved = false;

  private readonly buttons: Record<Tool, HTMLButtonElement>;
  private readonly undoButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly status: HTMLSpanElement;

  constructor(map: CollisionMap, overlay: CollisionOverlay, world: Container, stage: Container) {
    this.map = map;
    this.overlay = overlay;
    this.world = world;
    this.cursor.visible = false;
    world.addChild(this.cursor);

    const bar = document.createElement("div");
    bar.className = "map-editor";
    bar.innerHTML = `
      <span class="title">Collision</span>
      <button type="button" data-tool="draw" title="Mark cells blocked (B)">Draw</button>
      <button type="button" data-tool="erase" title="Make cells walkable (E)">Erase</button>
      <label>Brush <select></select></label>
      <button type="button" data-action="undo" title="Undo (Ctrl+Z)" disabled>Undo</button>
      <button type="button" data-action="save">Save</button>
      <span class="status" aria-live="polite">No changes</span>`;
    document.body.appendChild(bar);

    this.buttons = {
      draw: bar.querySelector('[data-tool="draw"]')!,
      erase: bar.querySelector('[data-tool="erase"]')!,
    };
    this.undoButton = bar.querySelector('[data-action="undo"]')!;
    this.saveButton = bar.querySelector('[data-action="save"]')!;
    this.status = bar.querySelector(".status")!;
    const select = bar.querySelector("select")!;
    select.innerHTML = BRUSH_SIZES.map((n) => `<option value="${n}">${n}×${n}</option>`).join("");
    select.value = String(this.brush);
    select.addEventListener("change", () => {
      this.brush = Number(select.value);
      select.blur();
    });

    this.buttons.draw.addEventListener("click", () => this.selectTool("draw"));
    this.buttons.erase.addEventListener("click", () => this.selectTool("erase"));
    this.undoButton.addEventListener("click", () => this.undo());
    this.saveButton.addEventListener("click", () => this.save());

    window.addEventListener("keydown", (e) => {
      if (document.activeElement instanceof HTMLInputElement) return;
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
        e.preventDefault();
        this.undo();
      } else if (e.code === "KeyB") {
        this.selectTool("draw");
      } else if (e.code === "KeyE") {
        this.selectTool("erase");
      }
    });
    window.addEventListener("beforeunload", (e) => {
      if (this.unsaved) e.preventDefault();
    });

    stage.on("pointerdown", (e) => this.onPointerDown(e));
    stage.on("globalpointermove", (e) => this.onPointerMove(e));
    stage.on("pointerup", () => this.endStroke());
    stage.on("pointerupoutside", () => this.endStroke());
  }

  /** True while a paint tool is selected; the game then ignores taps for movement. */
  get active(): boolean {
    return this.tool !== null;
  }

  /** Clicking the selected tool again returns to normal play. */
  private selectTool(tool: Tool): void {
    this.tool = this.tool === tool ? null : tool;
    for (const [name, button] of Object.entries(this.buttons)) {
      button.setAttribute("aria-pressed", String(name === this.tool));
    }
    this.cursor.visible = this.tool !== null;
  }

  private cellAt(e: FederatedPointerEvent): { cx: number; cy: number } {
    const p = this.world.toLocal(e.global);
    return { cx: Math.floor(p.x / this.map.cellSize), cy: Math.floor(p.y / this.map.cellSize) };
  }

  private onPointerDown(e: FederatedPointerEvent): void {
    if (!this.tool) return;
    this.stroke = [];
    const cell = this.cellAt(e);
    this.paintBrush(cell.cx, cell.cy);
    this.lastCell = cell;
  }

  private onPointerMove(e: FederatedPointerEvent): void {
    if (!this.tool) return;
    const cell = this.cellAt(e);
    this.drawCursor(cell.cx, cell.cy);
    if (!this.stroke || !this.lastCell) return;
    // Fill the gap between pointer samples so fast strokes stay continuous.
    const steps = Math.max(Math.abs(cell.cx - this.lastCell.cx), Math.abs(cell.cy - this.lastCell.cy));
    for (let i = 1; i <= steps; i++) {
      this.paintBrush(
        Math.round(this.lastCell.cx + ((cell.cx - this.lastCell.cx) * i) / steps),
        Math.round(this.lastCell.cy + ((cell.cy - this.lastCell.cy) * i) / steps),
      );
    }
    this.lastCell = cell;
  }

  private endStroke(): void {
    if (this.stroke?.length) {
      this.undoStack.push(this.stroke);
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      this.markUnsaved();
    }
    this.stroke = null;
    this.lastCell = null;
  }

  private paintBrush(cx: number, cy: number): void {
    const walkable = this.tool === "erase";
    const start = -Math.floor((this.brush - 1) / 2);
    for (let dy = 0; dy < this.brush; dy++) {
      for (let dx = 0; dx < this.brush; dx++) {
        const x = cx + start + dx;
        const y = cy + start + dy;
        if (this.map.setCell(x, y, walkable)) {
          this.overlay.setCell(x, y, walkable);
          // Record the previous value so the stroke can be undone.
          this.stroke?.push({ cx: x, cy: y, walkable: !walkable });
        }
      }
    }
    this.overlay.flush();
  }

  private drawCursor(cx: number, cy: number): void {
    const size = this.map.cellSize;
    const start = -Math.floor((this.brush - 1) / 2);
    this.cursor
      .clear()
      .rect((cx + start) * size, (cy + start) * size, this.brush * size, this.brush * size)
      .stroke({ color: this.tool === "erase" ? 0x4fd1ff : 0xff3030, width: 1 });
  }

  private undo(): void {
    const stroke = this.undoStack.pop();
    if (!stroke) return;
    for (const c of stroke) {
      this.map.setCell(c.cx, c.cy, c.walkable);
      this.overlay.setCell(c.cx, c.cy, c.walkable);
    }
    this.overlay.flush();
    this.markUnsaved();
  }

  private markUnsaved(): void {
    this.unsaved = true;
    this.status.textContent = "Unsaved changes";
    this.undoButton.disabled = this.undoStack.length === 0;
  }

  private async save(): Promise<void> {
    this.saveButton.disabled = true;
    this.status.textContent = "Saving…";
    try {
      const res = await fetch("/api/collision", { method: "PUT", body: this.map.serialize() });
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      this.unsaved = false;
      this.status.textContent = "Saved";
    } catch (err) {
      this.status.textContent = `Save failed: ${(err as Error).message}`;
    } finally {
      this.saveButton.disabled = false;
    }
  }
}
