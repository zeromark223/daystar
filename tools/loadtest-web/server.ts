/**
 * The load test with a web UI: pick or edit a scenario in the browser, start it,
 * watch its rows live, stop it, download its CSV. One run at a time; the bots run
 * here (tools/loadtest.ts), the browser only drives them. Scenarios live in the
 * browser's storage; this server keeps the last few runs in memory.
 *
 *   LOADTEST_TOKEN=… bun tools/loadtest-web/server.ts
 *
 * Environment:
 *   LOADTEST_PORT    port to listen on (default 3100)
 *   LOADTEST_TOKEN   the UI asks for it; without one a random token is made and printed
 *   LOADTEST_TARGET  server the UI suggests when a scenario names none
 *   HEALTH_TOKEN     the target's /api/health token (never sent to the browser)
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { OPTION_SPECS, parseOptions, runOrchestrator, UsageError, type Row } from "../loadtest.ts";
import { TEMPLATES } from "./templates.ts";

const PORT = Number(process.env.LOADTEST_PORT) || 3100;
const TOKEN = process.env.LOADTEST_TOKEN || randomBytes(18).toString("base64url");
const MAX_RUNS = 20;
const MAX_EVENTS = 5000;
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};

/** Options the UI may set: everything but the command-line-only ones (and the health token, which stays here). */
const UI_OPTIONS = OPTION_SPECS.filter((o) => !o.cliOnly && o.name !== "health-token");

type RunEvent =
  | { t: number; type: "log" | "warn" | "header"; text: string }
  | { t: number; type: "row"; text: string; values: Row };

interface Run {
  id: number;
  name: string;
  /** The command line it amounts to. */
  argv: string[];
  status: "running" | "stopping" | "done" | "stopped" | "failed";
  startedAt: number;
  endedAt: number | null;
  summary: string;
  log: string | null;
  events: RunEvent[];
  /** Events dropped from the front when a run gets long. */
  dropped: number;
  abort: AbortController;
}

const runs: Run[] = [];
let nextId = 1;
const current = () => runs.find((r) => r.status === "running" || r.status === "stopping");

function push(run: Run, event: RunEvent): void {
  run.events.push(event);
  if (run.events.length > MAX_EVENTS) {
    // Keep the table: drop the oldest log lines first.
    const i = run.events.findIndex((e) => e.type === "log" || e.type === "warn");
    run.events.splice(i >= 0 ? i : 0, 1);
    run.dropped++;
  }
}

/** The UI's form, as a command line; unknown options and odd values are refused. */
function toArgv(options: unknown): string[] {
  if (typeof options !== "object" || options === null) throw new UsageError("options must be an object");
  const argv: string[] = [];
  for (const [name, value] of Object.entries(options)) {
    const spec = UI_OPTIONS.find((o) => o.name === name);
    if (!spec) throw new UsageError(`unknown option "${name}"`);
    if (spec.type === "boolean") {
      if (value === true) argv.push(`--${name}`);
      else if (value !== false && value !== undefined) throw new UsageError(`--${name} is on or off`);
    } else if (value !== undefined && value !== "") {
      if (typeof value !== "string" || value.length > 300) throw new UsageError(`--${name} must be text`);
      argv.push(`--${name}`, value.trim());
    }
  }
  return argv;
}

function startRun(name: string, argv: string[]): Run {
  const opts = parseOptions(argv);
  const run: Run = {
    id: nextId++,
    name,
    argv: opts.argv,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    summary: "",
    log: opts.log,
    events: [],
    dropped: 0,
    abort: new AbortController(),
  };
  runs.push(run);
  while (runs.length > MAX_RUNS) runs.splice(runs.findIndex((r) => r !== current()), 1);
  const event = (type: "log" | "warn" | "header") => (text: string) => push(run, { t: Date.now(), type, text });
  runOrchestrator(
    opts,
    { log: event("log"), warn: event("warn"), header: event("header"), row: (text, values) => push(run, { t: Date.now(), type: "row", text, values }) },
    run.abort.signal,
  )
    .then((result) => {
      run.summary = result.summary;
      run.status = result.stopped ? "stopped" : "done";
    })
    .catch((err) => {
      run.summary = (err as Error).message;
      run.status = "failed";
      push(run, { t: Date.now(), type: "warn", text: run.summary });
    })
    .finally(() => {
      run.endedAt = Date.now();
    });
  return run;
}

/** A run without its controller, and its events from `since` on. */
function view(run: Run, since = 0) {
  const from = Math.max(0, since - run.dropped);
  return {
    id: run.id,
    name: run.name,
    command: `bun tools/loadtest.ts ${run.argv.join(" ")}`.trim(),
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    summary: run.summary,
    hasCsv: run.log !== null && existsSync(run.log),
    events: run.events.slice(from),
    next: run.dropped + run.events.length,
  };
}

function authorized(req: Request): boolean {
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function api(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/meta" && req.method === "GET") {
    return json({
      options: UI_OPTIONS,
      templates: TEMPLATES,
      target: process.env.LOADTEST_TARGET ?? "",
      healthToken: Boolean(process.env.HEALTH_TOKEN),
      current: current()?.id ?? null,
    });
  }
  if (path === "/api/runs" && req.method === "GET") {
    return json(runs.map((r) => ({ ...view(r), events: undefined })).reverse());
  }
  if (path === "/api/runs" && req.method === "POST") {
    if (current()) return json({ error: "A run is already going; stop it first." }, 409);
    let body: { name?: unknown; options?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Expected JSON" }, 400);
    }
    try {
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Untitled";
      return json(view(startRun(name, toArgv(body.options))), 201);
    } catch (err) {
      if (err instanceof UsageError) return json({ error: err.message }, 400);
      throw err;
    }
  }
  const match = path.match(/^\/api\/runs\/(\d+)(\/stop|\/csv)?$/);
  const run = match && runs.find((r) => r.id === Number(match[1]));
  if (!match) return json({ error: "Not found" }, 404);
  if (!run) return json({ error: "No such run (only the last few are kept)" }, 404);
  if (!match[2] && req.method === "GET") return json(view(run, Number(url.searchParams.get("since")) || 0));
  if (match[2] === "/stop" && req.method === "POST") {
    if (run.status === "running") {
      run.status = "stopping";
      run.abort.abort();
    }
    return json(view(run, Number.MAX_SAFE_INTEGER));
  }
  if (match[2] === "/csv" && req.method === "GET" && run.log && existsSync(run.log)) {
    return new Response(Bun.file(run.log), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${basename(run.log)}"` },
    });
  }
  return json({ error: "Not found" }, 404);
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const file = STATIC[url.pathname];
    if (file && req.method === "GET") {
      const ext = file.split(".").pop()!;
      return new Response(readFileSync(resolve(import.meta.dirname, file)), {
        headers: { "content-type": TYPES[ext], "cache-control": "no-cache" },
      });
    }
    if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    if (!authorized(req)) return json({ error: "Wrong or missing token" }, 401);
    try {
      return await api(req, url);
    } catch (err) {
      console.error(err);
      return json({ error: (err as Error).message }, 500);
    }
  },
});

console.log(`Load test UI on http://localhost:${server.port}`);
if (!process.env.LOADTEST_TOKEN) console.log(`No LOADTEST_TOKEN set; this run's token: ${TOKEN}`);

// Stopping the container: stop the run so its bots and any spawned server go too.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    const run = current();
    if (run) {
      run.abort.abort();
      const deadline = Date.now() + 5000;
      while (run.endedAt === null && Date.now() < deadline) await Bun.sleep(100);
    }
    process.exit(0);
  });
}
