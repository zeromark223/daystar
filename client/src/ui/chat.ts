import { MAX_CHAT_LENGTH } from "../../../shared/src/constants.ts";
import type { ChatMessage } from "../../../shared/src/protocol.ts";

const NAME_COLORS = ["#ffd166", "#9be564", "#7fd1f7", "#f79ad3", "#ffa36c", "#c3a6ff", "#6fe3c1"];

function colorFor(playerId: number): string {
  return NAME_COLORS[playerId % NAME_COLORS.length];
}

type Tab = "all" | "chat" | "system";
type Kind = "chat" | "system";
const TAB_KEY = "daystar:chat-tab";
/** Lines kept of each kind, so a burst of joins does not push the conversation out. */
const KEEP = 200;
const isTab = (v: unknown): v is Tab => v === "all" || v === "chat" || v === "system";

export class ChatPanel {
  private readonly log = document.getElementById("chat-log") as HTMLOListElement;
  private readonly form = document.getElementById("chat-form") as HTMLFormElement;
  private readonly input = document.getElementById("chat-input") as HTMLInputElement;
  private readonly tabs = [...document.querySelectorAll<HTMLButtonElement>(".chat-tabs [role=tab]")];
  private tab: Tab = "all";
  private readonly unread: Record<Kind, number> = { chat: 0, system: 0 };
  private readonly counts: Record<Kind, number> = { chat: 0, system: 0 };

  constructor(onSend: (text: string) => void) {
    this.input.maxLength = MAX_CHAT_LENGTH;
    for (const button of this.tabs) button.addEventListener("click", () => this.show(button.dataset.tab as Tab));
    // Arrow keys move between tabs, as in any tab list.
    this.tabs[0].parentElement!.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const i = this.tabs.findIndex((b) => b.dataset.tab === this.tab);
      const next = this.tabs[(i + (e.key === "ArrowRight" ? 1 : this.tabs.length - 1)) % this.tabs.length];
      this.show(next.dataset.tab as Tab);
      next.focus();
    });
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(TAB_KEY);
    } catch {
      // Storage blocked: All.
    }
    this.show(isTab(saved) ? saved : "all", false);
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (text) onSend(text);
      this.input.value = "";
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.input.blur();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && document.activeElement !== this.input) {
        e.preventDefault();
        this.input.focus();
      }
    });
  }

  addMessage(msg: ChatMessage): void {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.style.color = colorFor(msg.playerId);
    name.textContent = msg.name;
    li.title = new Date(msg.ts).toLocaleTimeString();
    li.append(name, msg.text);
    this.append(li, "chat");
  }

  addSystem(text: string): void {
    const li = document.createElement("li");
    li.className = "system";
    li.textContent = text;
    this.append(li, "system");
  }

  /** Show everything, only messages, or only system lines. */
  private show(tab: Tab, remember = true): void {
    this.tab = tab;
    this.log.dataset.tab = tab;
    for (const button of this.tabs) {
      const selected = button.dataset.tab === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    if (tab !== "system") this.unread.chat = 0;
    if (tab !== "chat") this.unread.system = 0;
    this.renderUnread();
    this.log.setAttribute("aria-labelledby", `chat-tab-${tab}`);
    this.log.scrollTop = this.log.scrollHeight;
    if (!remember) return;
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      // Not remembered; it still applies now.
    }
  }

  private renderUnread(): void {
    for (const button of this.tabs) {
      const kind = button.dataset.tab as Tab;
      const badge = button.querySelector<HTMLElement>(".unread");
      if (!badge || kind === "all") continue;
      const n = this.unread[kind];
      badge.hidden = n === 0;
      badge.textContent = n > 99 ? "99+" : String(n);
    }
  }

  private append(li: HTMLLIElement, kind: Kind): void {
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 24;
    this.log.appendChild(li);
    if (++this.counts[kind] > KEEP) {
      // The oldest line of this kind goes.
      const oldest = kind === "system" ? this.log.querySelector(".system") : this.log.querySelector("li:not(.system)");
      oldest?.remove();
      this.counts[kind]--;
    }
    // Lines the current tab hides count as unread on their own tab.
    const hidden = (this.tab === "chat" && kind === "system") || (this.tab === "system" && kind === "chat");
    if (hidden) {
      this.unread[kind]++;
      this.renderUnread();
    }
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
  }
}
