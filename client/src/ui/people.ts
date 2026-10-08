import { MAX_SPEAKERS } from "../../../shared/src/constants.ts";
import { ROLE_LABELS, type Role } from "../../../shared/src/roles.ts";

/** Guests listed before the filter is needed; big rooms have hundreds. */
const MAX_GUESTS_SHOWN = 100;

interface Person {
  id: number;
  name: string;
  role: Role;
  /** Raised hand ticket (when it went up), or 0. */
  hand: number;
}

export interface PeopleActions {
  setRole(id: number, role: "speaker" | "guest"): void;
  lowerHand(id: number): void;
}

const ORDER: Record<Role, number> = { host: 0, speaker: 1, guest: 2 };

/**
 * Who is in the room, host and speakers first. The host also gets the buttons
 * to choose speakers, here and in a small menu when tapping a player on the map.
 */
export class PeoplePanel {
  private readonly panel = document.getElementById("people")!;
  private readonly list = document.getElementById("people-list") as HTMLUListElement;
  private readonly filter = document.getElementById("people-filter") as HTMLInputElement;
  private readonly more = document.getElementById("people-more")!;
  private readonly toggle = document.getElementById("people-toggle") as HTMLButtonElement;
  private readonly menu = document.getElementById("pick-menu")!;
  private readonly people = new Map<number, Person>();
  private readonly actions: PeopleActions;
  private selfId = -1;
  private scheduled = false;

  constructor(actions: PeopleActions) {
    this.actions = actions;
    this.toggle.addEventListener("click", () => {
      this.panel.hidden = !this.panel.hidden;
      this.toggle.setAttribute("aria-expanded", String(!this.panel.hidden));
      this.render();
    });
    document.getElementById("people-close")!.addEventListener("click", () => {
      this.panel.hidden = true;
      this.toggle.setAttribute("aria-expanded", "false");
    });
    this.filter.addEventListener("input", () => this.render());
    this.filter.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.filter.blur();
    });
    window.addEventListener("pointerdown", (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target as Node)) this.closeMenu();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeMenu();
    });
  }

  private get selfIsHost(): boolean {
    return this.people.get(this.selfId)?.role === "host";
  }

  get speakerCount(): number {
    let n = 0;
    for (const p of this.people.values()) if (p.role === "speaker") n++;
    return n;
  }

  get size(): number {
    return this.people.size;
  }

  nameOf(id: number): string | undefined {
    return this.people.get(id)?.name;
  }

  roleOf(id: number): Role | undefined {
    return this.people.get(id)?.role;
  }

  setSelf(id: number): void {
    this.selfId = id;
    this.schedule();
  }

  upsert(id: number, name: string, role: Role, hand = 0): void {
    this.people.set(id, { id, name, role, hand });
    this.schedule();
    this.renderToggle();
  }

  handOf(id: number): number {
    return this.people.get(id)?.hand ?? 0;
  }

  setHand(id: number, hand: number): void {
    const p = this.people.get(id);
    if (!p || p.hand === hand) return;
    p.hand = hand;
    this.schedule();
    this.renderToggle();
  }

  /** The host sees how many hands are up on the People button. */
  private renderToggle(): void {
    let hands = 0;
    if (this.selfIsHost) for (const p of this.people.values()) if (p.hand) hands++;
    this.toggle.textContent = hands > 0 ? `People · ✋ ${hands}` : "People";
  }

  setRole(id: number, role: Role): void {
    const p = this.people.get(id);
    if (!p) return;
    p.role = role;
    this.schedule();
    this.renderToggle();
  }

  remove(id: number): void {
    this.people.delete(id);
    if (this.menu.dataset.id === String(id)) this.closeMenu();
    this.schedule();
    this.renderToggle();
  }

  clear(): void {
    this.people.clear();
    this.closeMenu();
    this.schedule();
  }

  /** The host tapped a player on the map: offer the role change right there. */
  openMenu(id: number, x: number, y: number): void {
    const p = this.people.get(id);
    if (!p || !this.selfIsHost || p.role === "host") return;
    const title = document.createElement("strong");
    title.textContent = p.name;
    const role = document.createElement("span");
    role.className = "role";
    role.textContent = ROLE_LABELS[p.role];
    this.menu.replaceChildren(title, role, this.roleButton(p, () => this.closeMenu()));
    this.menu.dataset.id = String(id);
    this.menu.hidden = false;
    const { width, height } = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.min(Math.max(8, x + 12), innerWidth - width - 8)}px`;
    this.menu.style.top = `${Math.min(Math.max(8, y + 12), innerHeight - height - 8)}px`;
  }

  private closeMenu(): void {
    this.menu.hidden = true;
    delete this.menu.dataset.id;
  }

  private roleButton(p: Person, after?: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    const promote = p.role === "guest";
    b.textContent = promote ? "Make speaker" : "Make guest";
    b.className = promote ? "" : "secondary";
    if (promote && this.speakerCount >= MAX_SPEAKERS) {
      b.disabled = true;
      b.title = `At most ${MAX_SPEAKERS} speakers`;
    }
    b.addEventListener("click", () => {
      this.actions.setRole(p.id, promote ? "speaker" : "guest");
      after?.();
    });
    return b;
  }

  private heading(text: string): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "heading";
    li.textContent = text;
    return li;
  }

  private schedule(): void {
    if (this.scheduled || this.panel.hidden) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.render();
    });
  }

  private render(): void {
    if (this.panel.hidden) return;
    const query = this.filter.value.trim().toLowerCase();
    const sorted = [...this.people.values()]
      .filter((p) => !query || p.name.toLowerCase().includes(query))
      .sort((a, b) => ORDER[a.role] - ORDER[b.role] || a.name.localeCompare(b.name));
    let guests = 0;
    const items: HTMLLIElement[] = [];
    // The host answers raised hands first, oldest first.
    const hands = this.selfIsHost ? sorted.filter((p) => p.hand > 0).sort((a, b) => a.hand - b.hand) : [];
    if (hands.length > 0) {
      items.push(this.heading(`Raised hands · ${hands.length}`));
      for (const p of hands) {
        const li = document.createElement("li");
        li.className = "raised";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = `✋ ${p.name}`;
        const lower = document.createElement("button");
        lower.type = "button";
        lower.className = "secondary";
        lower.textContent = "Lower";
        lower.addEventListener("click", () => this.actions.lowerHand(p.id));
        li.append(name, this.roleButton(p), lower);
        items.push(li);
      }
      items.push(this.heading("Everyone"));
    }
    for (const p of sorted) {
      if (p.role === "guest" && ++guests > MAX_GUESTS_SHOWN) continue;
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = (p.hand ? "✋ " : "") + (p.id === this.selfId ? `${p.name} (you)` : p.name);
      li.append(name);
      if (p.role !== "guest") {
        const badge = document.createElement("span");
        badge.className = `badge ${p.role}`;
        badge.textContent = ROLE_LABELS[p.role];
        li.append(badge);
      }
      if (this.selfIsHost && p.role !== "host") li.append(this.roleButton(p));
      items.push(li);
    }
    this.list.replaceChildren(...items);
    this.renderToggle();
    const hidden = guests - MAX_GUESTS_SHOWN;
    this.more.hidden = hidden <= 0;
    this.more.textContent = `and ${hidden} more; type a name to find them`;
  }
}
