import type { Role } from "../../../shared/src/roles.ts";

interface Step {
  title: string;
  text: string;
  /** CSS selector of the control the step is about; the step is centered without one. */
  target?: string;
}

const TOUCH = matchMedia("(pointer: coarse)").matches;
const KEY = (role: Role) => `daystar:tutorial:${role}`;

const STEPS: Record<Role, Step[]> = {
  guest: [
    {
      title: "Welcome to Daystar",
      text: "Everyone here is a star or a planet in orbit around a shared sun. The one with the white ring is you.",
    },
    {
      title: "Move around",
      text: TOUCH
        ? "Drag anywhere to steer, or tap where you want to go. Pinch with two fingers to zoom."
        : "Walk with WASD or the arrow keys, or click where you want to go. Scroll or press + and − to zoom.",
    },
    {
      title: "Listen in",
      text: "The host (the sun) and the speakers talk, everyone else listens. If you hear nothing, check that sound is on.",
      target: "#sound-button",
    },
    {
      title: "React and raise your hand",
      text: TOUCH
        ? "Send a reaction everyone around you sees. Raise your hand (✋) to ask the host for the floor."
        : "Send a reaction (keys 1–6) everyone around you sees. Raise your hand (H) to ask the host for the floor.",
      target: "#audience",
    },
    {
      title: "Chat",
      text: "Write to the whole room here. Your message also pops up above your head for a few seconds.",
      target: ".chat",
    },
    {
      title: "Polls",
      text: "When the host asks a question, each answer becomes a planet around the sun. Fly into one to vote.",
    },
    {
      title: "Bring friends",
      text: "Copy the invite link, or show the QR code so people next to you can scan it.",
      target: ".room-chip",
    },
  ],
  speaker: [
    {
      title: "You can speak now",
      text: "The host invited you to speak. Turn your mic on when you are ready; the ring around you swells while you talk.",
      target: "#mic-button",
    },
    {
      title: "Everyone hears you",
      text: "Speakers are heard by the whole room, wherever people are on the map. Turn the mic off when you are done.",
    },
  ],
  host: [
    {
      title: "You are the host",
      text: "You are the sun at the center of the room. Everyone hears you, and you decide who else may speak.",
    },
    {
      title: "Your microphone",
      text: "Turn your mic on to talk to the room. Your browser will ask for permission the first time.",
      target: "#mic-button",
    },
    {
      title: "Choose speakers",
      text: "Tap a player on the map, or open People, to make them a speaker (up to 8). Raised hands show up in People, oldest first.",
      target: "#people-toggle",
    },
    {
      title: "Ask the room",
      text: "Start a poll with 2 to 4 answers. Each answer becomes a planet around you, and people vote by flying to it.",
      target: "#poll-button",
    },
    {
      title: "Gather everyone",
      text: "When you are about to talk, gather everyone: they fly in and circle the sun, speakers closest, until you let them go.",
      target: "#gather-button",
    },
    {
      title: "Invite people",
      text: "Share the invite link or the QR code. Keep using this browser: it holds the key that makes you the host of this room.",
      target: ".room-chip",
    },
  ],
};

/** Whether `role`'s tutorial was finished or skipped. Storage may be blocked; remember in memory then. */
const seenInMemory = new Set<Role>();

function seen(role: Role): boolean {
  if (seenInMemory.has(role)) return true;
  try {
    return localStorage.getItem(KEY(role)) === "done";
  } catch {
    return false;
  }
}

function markSeen(role: Role): void {
  seenInMemory.add(role);
  try {
    localStorage.setItem(KEY(role), "done");
  } catch {
    // Private mode or blocked storage: it will show again next visit.
  }
}

function forgetAll(): void {
  seenInMemory.clear();
  for (const role of Object.keys(STEPS) as Role[]) {
    try {
      localStorage.removeItem(KEY(role));
    } catch {
      // Nothing stored.
    }
  }
}

/**
 * A short guided tour for each role, shown the first time someone joins as a
 * guest, becomes a speaker, or hosts. Each step is a card next to the control it
 * explains (lit by a spotlight), with Back, Next and Skip; Skip or the last step
 * stores that the tour was seen.
 */
export class Tutorial {
  private readonly card: HTMLElement;
  private readonly spot: HTMLElement;
  private role: Role | null = null;
  private steps: Step[] = [];
  private index = 0;
  /** A tour waiting for the current one to end (e.g. made speaker mid-tour). */
  private queued: Role | null = null;

  constructor() {
    this.spot = document.createElement("div");
    this.spot.className = "tour-spot";
    this.spot.hidden = true;
    this.card = document.createElement("section");
    this.card.className = "tour-card";
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-live", "polite");
    this.card.hidden = true;
    document.body.append(this.spot, this.card);
    window.addEventListener("resize", () => this.place());
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.role) this.finish();
    });
  }

  /** Show `role`'s tour unless it was seen already. */
  offer(role: Role): void {
    if (seen(role)) return;
    if (this.role && this.role !== role) {
      this.queued = role;
      return;
    }
    this.start(role);
  }

  /** From Settings: forget what was seen and run the tour for `role` now. */
  replay(role: Role): void {
    forgetAll();
    this.queued = null;
    this.start(role);
  }

  private start(role: Role): void {
    this.role = role;
    this.steps = STEPS[role];
    this.index = 0;
    this.render();
  }

  private finish(): void {
    if (this.role) markSeen(this.role);
    this.role = null;
    this.card.hidden = true;
    this.spot.hidden = true;
    const next = this.queued;
    this.queued = null;
    if (next) this.offer(next);
  }

  private go(delta: number): void {
    const next = this.index + delta;
    if (next >= this.steps.length) {
      this.finish();
      return;
    }
    this.index = Math.max(0, next);
    this.render();
  }

  private render(): void {
    const step = this.steps[this.index];
    const last = this.index === this.steps.length - 1;
    const count = document.createElement("span");
    count.className = "tour-count";
    count.textContent = `${this.index + 1} / ${this.steps.length}`;
    const title = document.createElement("h2");
    title.textContent = step.title;
    const text = document.createElement("p");
    text.textContent = step.text;

    const skip = this.button("Skip tutorial", "secondary link", () => this.finish());
    const nav = document.createElement("div");
    nav.className = "tour-nav";
    if (this.index > 0) nav.append(this.button("Back", "secondary", () => this.go(-1)));
    const next = this.button(last ? "Done" : "Next", "", () => this.go(1));
    nav.append(next);
    const footer = document.createElement("footer");
    footer.append(last ? document.createElement("span") : skip, nav);

    this.card.replaceChildren(count, title, text, footer);
    this.card.setAttribute("aria-label", step.title);
    this.card.hidden = false;
    this.place();
    next.focus({ preventScroll: true });
  }

  private button(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  /** Light the step's control and put the card beside it (or in the middle). */
  private place(): void {
    if (!this.role) return;
    const step = this.steps[this.index];
    const target = step.target ? document.querySelector<HTMLElement>(step.target) : null;
    const rect = target && target.offsetParent !== null ? target.getBoundingClientRect() : null;
    const card = this.card;
    card.style.left = card.style.top = "";
    card.classList.toggle("centered", !rect);
    if (!rect || rect.width === 0) {
      this.spot.hidden = true;
      return;
    }
    const pad = 6;
    // Coming back from a step without a target: jump there instead of sliding from a stale spot.
    const wasHidden = this.spot.hidden;
    if (wasHidden) this.spot.style.transition = "none";
    Object.assign(this.spot.style, {
      left: `${rect.left - pad}px`,
      top: `${rect.top - pad}px`,
      width: `${rect.width + pad * 2}px`,
      height: `${rect.height + pad * 2}px`,
    });
    this.spot.hidden = false;
    if (wasHidden) {
      void this.spot.offsetWidth;
      this.spot.style.transition = "";
    }
    // Below the control if it fits, else above; kept inside the screen.
    const { width, height } = card.getBoundingClientRect();
    const gap = 14;
    const below = rect.bottom + gap + height <= innerHeight - 8;
    const top = below ? rect.bottom + gap : Math.max(8, rect.top - gap - height);
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), innerWidth - width - 8);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }
}
