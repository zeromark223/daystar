/** How far (CSS px) a finger must travel before a press becomes a drag instead of a tap. */
const DRAG_START = 10;
/** Radius of the stick's base: dragging this far or more walks at full speed. */
const RADIUS = 56;
const DEAD_ZONE = 0.12;

/**
 * Touch controls for the map. Press anywhere and drag: a thumbstick appears
 * under the finger and steers the player (slower near the center). A quick tap
 * still means "go there" (handled by the game). Two fingers pinch to zoom.
 */
export class TouchStick {
  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly touches = new Map<number, { x: number; y: number }>();
  private stickId: number | null = null;
  private origin = { x: 0, y: 0 };
  private offset = { x: 0, y: 0 };
  private active = false;
  private pinchDistance = 0;
  /** The current gesture is a drag or pinch, so its release is not a tap. */
  private gestured = false;

  private readonly canSteer: () => boolean;
  private readonly onPinch: (factor: number) => void;

  constructor(target: HTMLElement, canSteer: () => boolean, onPinch: (factor: number) => void) {
    this.canSteer = canSteer;
    this.onPinch = onPinch;
    this.base = document.createElement("div");
    this.base.className = "stick";
    this.base.hidden = true;
    this.knob = document.createElement("div");
    this.knob.className = "stick-knob";
    this.base.appendChild(this.knob);
    document.body.appendChild(this.base);

    target.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      if (this.touches.size === 0) this.gestured = false;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 1) {
        this.stickId = e.pointerId;
        this.origin = { x: e.clientX, y: e.clientY };
        this.offset = { x: 0, y: 0 };
      } else {
        // A second finger: pinch instead of steering.
        this.release();
        this.gestured = true;
        this.pinchDistance = this.spread();
      }
    });
    target.addEventListener("pointermove", (e) => {
      const touch = this.touches.get(e.pointerId);
      if (!touch) return;
      touch.x = e.clientX;
      touch.y = e.clientY;
      if (this.touches.size >= 2) {
        const d = this.spread();
        if (this.pinchDistance > 0 && d > 0) this.onPinch(d / this.pinchDistance);
        this.pinchDistance = d;
        return;
      }
      if (e.pointerId !== this.stickId) return;
      const dx = e.clientX - this.origin.x;
      const dy = e.clientY - this.origin.y;
      if (!this.active) {
        if (Math.hypot(dx, dy) < DRAG_START || !this.canSteer()) return;
        this.active = true;
        this.gestured = true;
        this.base.style.left = `${this.origin.x}px`;
        this.base.style.top = `${this.origin.y}px`;
        this.base.hidden = false;
      }
      const len = Math.hypot(dx, dy);
      const k = len > RADIUS ? RADIUS / len : 1;
      this.offset = { x: dx * k, y: dy * k };
      this.knob.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px)`;
    });
    const end = (e: PointerEvent) => {
      if (!this.touches.delete(e.pointerId)) return;
      if (e.pointerId === this.stickId) this.release();
      if (this.touches.size < 2) this.pinchDistance = 0;
    };
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
    window.addEventListener("blur", () => {
      this.touches.clear();
      this.release();
    });
  }

  /** Steering direction, length 0..1 (0 when the stick is not held). */
  vector(): { x: number; y: number } {
    if (!this.active || !this.canSteer()) return { x: 0, y: 0 };
    const x = this.offset.x / RADIUS;
    const y = this.offset.y / RADIUS;
    const len = Math.hypot(x, y);
    if (len < DEAD_ZONE) return { x: 0, y: 0 };
    const k = (len - DEAD_ZONE) / (1 - DEAD_ZONE) / len;
    return { x: x * k, y: y * k };
  }

  /** True if the gesture that just ended was a drag or pinch (so it is not a tap). */
  wasGesture(): boolean {
    return this.gestured;
  }

  private release(): void {
    this.stickId = null;
    this.active = false;
    this.offset = { x: 0, y: 0 };
    this.base.hidden = true;
  }

  private spread(): number {
    const [a, b] = [...this.touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}
