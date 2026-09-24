import { MAX_CHAT_LENGTH } from "../../../shared/src/constants.ts";
import type { ChatMessage } from "../../../shared/src/protocol.ts";

const NAME_COLORS = ["#ffd166", "#9be564", "#7fd1f7", "#f79ad3", "#ffa36c", "#c3a6ff", "#6fe3c1"];

function colorFor(playerId: number): string {
  return NAME_COLORS[playerId % NAME_COLORS.length];
}

export class ChatPanel {
  private readonly log = document.getElementById("chat-log") as HTMLOListElement;
  private readonly form = document.getElementById("chat-form") as HTMLFormElement;
  private readonly input = document.getElementById("chat-input") as HTMLInputElement;

  constructor(onSend: (text: string) => void) {
    this.input.maxLength = MAX_CHAT_LENGTH;
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
    this.append(li);
  }

  addSystem(text: string): void {
    const li = document.createElement("li");
    li.className = "system";
    li.textContent = text;
    this.append(li);
  }

  private append(li: HTMLLIElement): void {
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 24;
    this.log.appendChild(li);
    while (this.log.children.length > 200) this.log.firstElementChild?.remove();
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
  }
}
