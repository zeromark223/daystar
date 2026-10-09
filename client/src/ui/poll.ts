import { POLL_MAX_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX, type Poll } from "../../../shared/src/poll.ts";
import { ANSWER_COLORS } from "../game/poll-zones.ts";

export interface PollActions {
  start(question: string, options: string[]): void;
  end(): void;
}

/** A finished poll's card stays up this long (its planets fade at the same time). */
const RESULT_MS = 12_000;

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

/**
 * The poll card (question, live counts, which planet we are on), and for the
 * host the button and form that start one and the button that ends it.
 */
export class PollPanel {
  private readonly card = document.getElementById("poll-card")!;
  private readonly button = document.getElementById("poll-button") as HTMLButtonElement;
  private readonly dialog = document.getElementById("poll-dialog") as HTMLDialogElement;
  private readonly form = document.getElementById("poll-form") as HTMLFormElement;
  private readonly actions: PollActions;
  private poll: Poll | null = null;
  private isHost = false;
  private locked = false;
  private mine = -1;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(actions: PollActions) {
    this.actions = actions;
    const question = this.form.querySelector<HTMLInputElement>("#poll-question")!;
    question.maxLength = POLL_QUESTION_MAX;
    const options = this.form.querySelector("#poll-options")!;
    options.replaceChildren(
      ...Array.from({ length: POLL_MAX_OPTIONS }, (_, i) => {
        const input = document.createElement("input");
        input.id = `poll-option-${i}`;
        input.maxLength = POLL_OPTION_MAX;
        input.placeholder = i < 2 ? `Answer ${i + 1}` : `Answer ${i + 1} (optional)`;
        input.required = i < 2;
        input.autocomplete = "off";
        input.style.setProperty("--answer", hex(ANSWER_COLORS[i]));
        input.setAttribute("aria-label", `Answer ${i + 1}`);
        return input;
      }),
    );
    this.button.addEventListener("click", () => {
      if (this.poll?.open) return;
      this.form.reset();
      this.dialog.showModal();
      question.focus();
    });
    document.getElementById("poll-cancel")!.addEventListener("click", () => this.dialog.close());
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const answers = [...options.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
      if (!question.value.trim() || answers.length < 2) return;
      this.actions.start(question.value.trim(), answers);
      this.dialog.close();
    });
  }

  setHost(isHost: boolean): void {
    this.isHost = isHost;
    this.button.hidden = !isHost;
    this.render();
  }

  /** No polls while everyone is gathered: answering means flying. */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.button.disabled = locked || this.poll?.open === true;
    this.button.title = locked ? "Polls are off while everyone is gathered" : "";
  }

  get visible(): boolean {
    return !this.card.hidden;
  }

  /** A poll started, or ended with its final counts. */
  show(poll: Poll): void {
    clearTimeout(this.hideTimer);
    this.poll = poll;
    this.button.disabled = poll.open || this.locked;
    if (!poll.open) this.hideTimer = setTimeout(() => this.hide(), RESULT_MS);
    this.render();
  }

  setCounts(counts: number[]): void {
    if (!this.poll?.open) return;
    this.poll.counts = counts;
    this.render();
  }

  /** The answer planet we are on (-1 for none). */
  setMine(zone: number): void {
    if (zone === this.mine) return;
    this.mine = zone;
    if (this.poll?.open) this.render();
  }

  hide(): void {
    clearTimeout(this.hideTimer);
    this.poll = null;
    this.button.disabled = this.locked;
    this.card.hidden = true;
  }

  private render(): void {
    const poll = this.poll;
    if (!poll) return;
    this.card.hidden = false;
    const total = poll.counts.reduce((a, b) => a + b, 0);
    const best = Math.max(0, ...poll.counts);

    const head = document.createElement("header");
    const eyebrow = document.createElement("span");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = poll.open ? "Poll" : "Result";
    head.append(eyebrow);
    if (!poll.open) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "secondary close";
      close.textContent = "×";
      close.setAttribute("aria-label", "Close");
      close.addEventListener("click", () => this.hide());
      head.append(close);
    }

    const question = document.createElement("h2");
    question.textContent = poll.question;

    const list = document.createElement("ol");
    list.className = "answers";
    poll.options.forEach((text, i) => {
      const n = poll.counts[i] ?? 0;
      const li = document.createElement("li");
      li.style.setProperty("--answer", hex(ANSWER_COLORS[i]));
      li.style.setProperty("--share", `${total ? (n / total) * 100 : 0}%`);
      if (poll.open && i === this.mine) li.classList.add("mine");
      if (!poll.open && n === best && best > 0) li.classList.add("won");
      const label = document.createElement("span");
      label.className = "text";
      label.textContent = text;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(n);
      li.append(label, count);
      list.append(li);
    });

    const hint = document.createElement("p");
    hint.className = "poll-hint";
    if (poll.open) {
      hint.textContent =
        this.mine >= 0 ? `Your answer: ${poll.options[this.mine]}` : "Fly to an answer's planet around the sun to vote.";
    } else {
      hint.textContent = total === 1 ? "1 vote" : `${total} votes`;
    }

    const parts: HTMLElement[] = [head, question, list, hint];
    if (poll.open && this.isHost) {
      const end = document.createElement("button");
      end.type = "button";
      end.textContent = "End poll";
      end.addEventListener("click", () => this.actions.end());
      parts.push(end);
    }
    this.card.replaceChildren(...parts);
  }
}
