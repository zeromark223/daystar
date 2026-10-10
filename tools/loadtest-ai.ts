/**
 * AI chat for load test bots (--chat-source ai): a local LLM (Ollama, at
 * OLLAMA_URL, model OLLAMA_MODEL) writes short group conversations ("scenes")
 * ahead of time, and a director plays them in each room, casting guests as the
 * speakers and sending each line when a person would have finished typing it.
 *
 * Bots never wait for the model: scenes are made into a buffer in the background
 * (kept topped up), saved to a cache file for later runs, and when the buffer is
 * empty the director reuses cached scenes or falls back to single static lines.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_CHAT_LENGTH } from "../shared/src/constants.ts";
import { chatLine } from "./loadtest-crowd.ts";

/**
 * Text-only and 5 GB: on the 12 GB RTX 4070 it was tried on, it answered 27 of 30
 * in ~2.6 s, where gemma4 (9.6 GB with its vision and audio parts) failed 13 of 30
 * for lack of memory and qwen3 could not do structured output.
 */
export const DEFAULT_MODEL = "llama3.1:8b";

/** One conversation: who says what, speakers as letters (cast to bots when played). */
export interface Scene {
  topic: string;
  lines: { speaker: string; text: string }[];
}

const SPEAKERS = ["A", "B", "C"];
/** Scenes kept ready, and when to make more. */
const BUFFER_TARGET = 24;
const BUFFER_LOW = 16;
/** Scenes kept in the cache file (newest). */
const CACHE_MAX = 2000;
const REQUEST_TIMEOUT_MS = 90_000;

const TOPICS = [
  "guessing how many people are in the room",
  "someone asks where the stage is",
  "comparing what time it is where everyone is",
  "someone's audio keeps cutting out and others help",
  "reacting to the talk that is going on right now",
  "the speaker made a joke and people react",
  "someone missed the start and asks what they missed",
  "asking whether the session is recorded",
  "how pretty the sun in the middle looks",
  "the colors of people's planets",
  "someone just figured out how to move and is flying around",
  "trying the emoji reactions",
  "someone raised their hand and waits to ask a question",
  "ideas for questions to ask the speaker",
  "the last poll and what people voted",
  "the moment the host pulled everyone into orbit around the sun",
  "joining from a phone and using the joystick",
  "what everyone does for work",
  "where people are joining from",
  "planning to grab food after the session",
  "coffee and snacks while watching",
  "someone's internet is slow",
  "comparing this to video calls with a grid of faces",
  "who else came to the last meetup",
  "a pet walking across someone's keyboard",
  "late night or early morning for some people",
  "sharing a tip they learned in the talk",
  "asking for the slides",
  "finding friends in the crowd",
  "how many people can fit in one room",
  "the next talk on the schedule",
  "small talk about the weather where they are",
  "someone is new and others welcome them",
  "a side project someone is working on",
  "favorite part of the event so far",
];
const MOODS = ["upbeat", "dry humor", "curious", "a bit tired but friendly", "excited", "chill", "playful"];

function systemPrompt(language: string): string {
  return `You write the group chat of real people attending a live online event in Daystar, a web app where each attendee shows up as a little glowing star or planet avatar they move around a shared sun. Speakers talk from a stage ring near the sun; the host can pull everyone into orbit around it; there are emoji reactions, raised hands, and polls you answer by flying your avatar to a planet.
The people are ordinary humans at a meetup: they talk about the event, the talks, their lives and the app itself. They are not stars and do not role-play as space objects.
Write like a busy group chat: short and casual, often lowercase, now and then a typo or half sentence, sometimes two messages in a row from one person. Each message under 90 characters. At most two emoji in the whole exchange. No greetings unless the topic is about arriving.
The speakers are the letters given. Names: to mention someone write {A}, {B} or {C} exactly like that, braces included, and never a bare letter. No other names, no brands, no links. Friendly and safe for work. Write in ${language}.`;
}

/**
 * Bare speaker letters used as names ("thanks A", "B, idk") as {A}, {B}: small
 * models forget the braces. B and C alone are always names; "A" only where it
 * cannot be the article.
 */
function braceNames(text: string): string {
  return text
    .replace(/(^|[^\w{])@?([BC])(?![\w}])/g, "$1{$2}")
    .replace(/(^|[^\w{])@A(?![\w}])/g, "$1{A}")
    .replace(/\b(thanks|thx|ty|hey|hi|ask|you|and|with|like)\s+A(?![\w}])/gi, "$1 {A}")
    .replace(/(^|[^\w{])A(?=\s*[,:!?]|\s*$)/g, "$1{A}");
}

const SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      minItems: 4,
      maxItems: 12,
      items: {
        type: "object",
        properties: { speaker: { type: "string", enum: SPEAKERS }, text: { type: "string" } },
        required: ["speaker", "text"],
      },
    },
  },
  required: ["lines"],
};

const pick = <T>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)];

/** A scene from the model's answer, or null if it is not usable. */
export function cleanScene(topic: string, raw: unknown): Scene | null {
  const lines = (raw as { lines?: unknown })?.lines;
  if (!Array.isArray(lines)) return null;
  const out: Scene["lines"] = [];
  for (const l of lines) {
    const speaker = (l as { speaker?: unknown })?.speaker;
    const raw = (l as { text?: unknown })?.text;
    if (typeof speaker !== "string" || !SPEAKERS.includes(speaker) || typeof raw !== "string") continue;
    // Links and stray markup have no place in a crowd's chat.
    const text = braceNames(raw.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim());
    if (!text || text.length > 160) continue;
    out.push({ speaker, text });
  }
  if (out.length < 3 || new Set(out.map((l) => l.speaker)).size < 2) return null;
  return { topic, lines: out };
}

export interface AiStats {
  ready: number;
  made: number;
  failed: number;
  reused: number;
  fallback: number;
  avgMs: number;
}

interface SceneSourceOptions {
  url: string;
  model: string;
  theme: string;
  language: string;
  cacheFile: string;
  log: (text: string) => void;
  warn: (text: string) => void;
  signal: AbortSignal;
}

/** Makes scenes with the model into a buffer, and keeps the cache file. */
export class SceneSource {
  private readonly buffer: Scene[] = [];
  private cache: Scene[] = [];
  private made = 0;
  private failed = 0;
  private reused = 0;
  private totalMs = 0;
  private lastError = "";
  private readonly opts: SceneSourceOptions;

  constructor(opts: SceneSourceOptions) {
    this.opts = opts;
    this.loadCache();
    // Start at once from earlier runs' scenes while the first new ones are made.
    for (const s of [...this.cache].sort(() => Math.random() - 0.5).slice(0, BUFFER_LOW)) this.buffer.push(s);
    void this.fill();
  }

  stats(): Omit<AiStats, "fallback"> {
    return {
      ready: this.buffer.length,
      made: this.made,
      failed: this.failed,
      reused: this.reused,
      avgMs: this.made ? Math.round(this.totalMs / this.made) : 0,
    };
  }

  /** A scene to play: a fresh one, else one from the cache, else null. */
  take(): Scene | null {
    const fresh = this.buffer.shift();
    if (fresh) return fresh;
    if (!this.cache.length) return null;
    this.reused++;
    return pick(this.cache);
  }

  private loadCache(): void {
    if (!existsSync(this.opts.cacheFile)) return;
    try {
      this.cache = readFileSync(this.opts.cacheFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Scene)
        .filter((s) => cleanScene(s.topic, s) !== null)
        .slice(-CACHE_MAX);
      this.opts.log(`AI chat: ${this.cache.length} cached scenes in ${this.opts.cacheFile}`);
    } catch (err) {
      this.opts.warn(`AI chat: ignoring the scene cache (${(err as Error).message})`);
      this.cache = [];
    }
  }

  private save(scene: Scene): void {
    this.cache.push(scene);
    try {
      mkdirSync(dirname(this.opts.cacheFile), { recursive: true });
      if (this.cache.length > CACHE_MAX * 1.25) {
        this.cache = this.cache.slice(-CACHE_MAX);
        writeFileSync(this.opts.cacheFile, this.cache.map((s) => JSON.stringify(s)).join("\n") + "\n");
      } else {
        appendFileSync(this.opts.cacheFile, JSON.stringify(scene) + "\n");
      }
    } catch {
      // The cache is a convenience; the run goes on without it.
    }
  }

  /** Keep the buffer topped up, one request at a time, backing off while the model fails. */
  private async fill(): Promise<void> {
    let backoff = 0;
    let warned = false;
    while (!this.opts.signal.aborted) {
      if (this.buffer.length >= BUFFER_TARGET) {
        await sleep(500, this.opts.signal);
        continue;
      }
      try {
        const t0 = performance.now();
        const scene = await this.generate();
        this.totalMs += performance.now() - t0;
        this.made++;
        this.buffer.push(scene);
        this.save(scene);
        if (warned) this.opts.log(`AI chat: ${this.opts.model} answers again`);
        if (this.made === 1) this.opts.log(`AI chat: first scene from ${this.opts.model} in ${Math.round(performance.now() - t0)} ms`);
        backoff = 0;
        warned = false;
      } catch (err) {
        if (this.opts.signal.aborted) return;
        this.failed++;
        const message = (err as Error).message;
        if (!warned || message !== this.lastError) {
          this.opts.warn(`AI chat: ${this.opts.model} at ${this.opts.url} failed (${message}); playing cached and static lines meanwhile`);
          warned = true;
          this.lastError = message;
        }
        backoff = Math.min(60_000, backoff ? backoff * 2 : 2_000);
        await sleep(backoff, this.opts.signal);
      }
    }
  }

  private async generate(): Promise<Scene> {
    const topic = pick(TOPICS);
    const speakers = SPEAKERS.slice(0, Math.random() < 0.45 ? 2 : 3);
    const count = 5 + Math.floor(Math.random() * 5);
    const user = `Event: ${this.opts.theme}. Speakers: ${speakers.join(", ")}. Mood: ${pick(MOODS)}. Topic: ${topic}. Write ${count} messages.`;
    const res = await fetch(`${this.opts.url.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.any([this.opts.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      body: JSON.stringify({
        model: this.opts.model,
        stream: false,
        think: false,
        keep_alive: "30m",
        format: SCHEMA,
        // A scene needs ~600 tokens of context; a small one keeps the model's memory down.
        options: { temperature: 1.0, num_ctx: 2048, num_predict: 700 },
        messages: [
          { role: "system", content: systemPrompt(this.opts.language) },
          { role: "user", content: user },
        ],
      }),
    });
    const body = (await res.json().catch(() => null)) as { error?: string; message?: { content?: string } } | null;
    if (!res.ok || !body?.message?.content) throw new Error(body?.error ?? `HTTP ${res.status}`);
    const scene = cleanScene(topic, JSON.parse(body.message.content));
    if (!scene) throw new Error("unusable answer");
    return scene;
  }
}

/** A guest the director can cast. */
interface Guest {
  index: number;
  name: string;
}

interface Playing {
  scene: Scene;
  cast: Map<string, Guest>;
  next: number;
  at: number;
}

/** About how many lines a scene plays per second (typing time and pauses). */
const SCENE_LINES_PER_S = 0.2;
const MAX_SCENES_PER_ROOM = 8;

/**
 * Plays scenes in each room: enough at once that the room chats at the rate
 * --chat-every asks for (guests / chat-every lines per second), each line sent by
 * the guest cast for its speaker after a typing pause.
 */
export class Director {
  private readonly rooms = new Map<string, { guests: Guest[]; playing: Playing[]; nextStart: number }>();
  private fallback = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly source: SceneSource;
  private readonly chatEveryMs: number;
  private readonly say: (index: number, text: string) => void;

  constructor(source: SceneSource, chatEveryMs: number, say: (index: number, text: string) => void) {
    this.source = source;
    this.chatEveryMs = chatEveryMs;
    this.say = say;
    this.timer = setInterval(() => this.tick(Date.now()), 200);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  addGuest(room: string, index: number, name: string): void {
    let r = this.rooms.get(room);
    if (!r) this.rooms.set(room, (r = { guests: [], playing: [], nextStart: 0 }));
    r.guests.push({ index, name });
  }

  stats(): AiStats {
    return { ...this.source.stats(), fallback: this.fallback };
  }

  private tick(now: number): void {
    for (const r of this.rooms.values()) {
      if (r.guests.length < 2) continue;
      const linesPerS = r.guests.length / (this.chatEveryMs / 1000);
      const wanted = Math.min(MAX_SCENES_PER_ROOM, Math.max(1, Math.round(linesPerS / SCENE_LINES_PER_S)));
      // Start scenes one at a time, a little apart, so they overlap like real chatter.
      if (r.playing.length < wanted && now >= r.nextStart) {
        r.nextStart = now + 1500 + Math.random() * 2500;
        this.start(r, now);
      }
      for (let i = r.playing.length - 1; i >= 0; i--) {
        const p = r.playing[i];
        if (now < p.at) continue;
        const line = p.scene.lines[p.next];
        const guest = p.cast.get(line.speaker)!;
        const text = line.text
          // Nobody mentions themselves ("nice one, {B}" from B): drop those.
          .replace(new RegExp(`,?\\s*\\{${line.speaker}\\}[,:]?`, "g"), "")
          .replace(/\{([A-C])\}/g, (_, s: string) => p.cast.get(s)?.name ?? "")
          .replace(/\s+/g, " ")
          .replace(/^[,:\s]+/, "")
          .trim();
        if (text) this.say(guest.index, text.slice(0, MAX_CHAT_LENGTH));
        p.next++;
        if (p.next >= p.scene.lines.length) {
          r.playing.splice(i, 1);
          continue;
        }
        p.at = now + typingMs(p.scene.lines[p.next].text, p.scene.lines[p.next].speaker === line.speaker);
      }
    }
  }

  private start(r: { guests: Guest[]; playing: Playing[] }, now: number): void {
    const busy = new Set(r.playing.flatMap((p) => [...p.cast.values()].map((g) => g.index)));
    const free = r.guests.filter((g) => !busy.has(g.index));
    const scene = this.source.take();
    const speakers = scene ? [...new Set(scene.lines.map((l) => l.speaker))] : [];
    if (!scene || free.length < speakers.length) {
      // Nothing to play (or nobody free): one static line from someone, as before.
      this.fallback++;
      const g = pick(free.length ? free : r.guests);
      this.say(g.index, chatLine(""));
      return;
    }
    const cast = new Map<string, Guest>();
    for (const s of speakers) cast.set(s, free.splice(Math.floor(Math.random() * free.length), 1)[0]);
    r.playing.push({ scene, cast, next: 0, at: now + Math.random() * 1500 });
  }
}

/** How long until the next line: a pause, then typing it (a quick follow-up from the same person comes sooner). */
function typingMs(text: string, sameSpeaker: boolean): number {
  return (sameSpeaker ? 600 : 1500) + text.length * 55 + Math.random() * 2500;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    if (signal.aborted) return r();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      r();
    }
    signal.addEventListener("abort", done);
  });
