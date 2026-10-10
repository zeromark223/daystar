// The load test's web UI: templates (built-in from the server, the user's own in
// localStorage), the form for one, and the live view of a run. No framework.

const STORE = "daystar-loadtest:";
const POLL_MS = 1000;

/** Columns of the results table (CSV names from tools/loadtest.ts) and their headings. */
const COLUMNS = [
  ["time_s", "t s"],
  ["bots", "bots"],
  ["joined", "joined"],
  ["srv_players", "srv players"],
  ["srv_cpu", "srv CPU"],
  ["load", "load"],
  ["out_mbps", "out Mbps"],
  ["loop_p99_ms", "loop p99"],
  ["tick_p99_ms", "tick p99"],
  ["rss_mb", "RSS MB"],
  ["move_p99_ms", "move p99"],
  ["gap_p99_ms", "gap p99"],
  ["chat_p99_ms", "chat p99"],
  ["voice_p99_ms", "voice p99"],
  ["voice_rx_pct", "voice rx %"],
  ["drops", "drops"],
  ["verdict", "verdict"],
];

/** Small charts over the run's rows. */
const CHARTS = [
  { key: "joined", label: "Bots in", unit: "" },
  { key: "srv_cpu", label: "Server CPU", unit: "%", scale: 100 },
  { key: "out_mbps", label: "Out", unit: " Mbps" },
  { key: "move_p99_ms", label: "Move p99", unit: " ms" },
  { key: "gap_p99_ms", label: "Snapshot gap p99", unit: " ms" },
  { key: "loop_p99_ms", label: "Loop p99", unit: " ms" },
  { key: "rss_mb", label: "Server RSS", unit: " MB" },
];

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- storage

/** localStorage can be missing or full (private windows, blocked storage): never let that break the page. */
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(STORE + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(STORE + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- api

let token = load("token", "");

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}`, ...init.headers },
  });
  if (res.status === 401) {
    askToken("That token was not accepted.");
    throw new Error("unauthorized");
  }
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.blob();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function askToken(error = "") {
  $("token-error").textContent = error;
  $("token-input").value = token;
  if (!$("token-dialog").open) $("token-dialog").showModal();
}

$("token-form").addEventListener("submit", () => {
  token = $("token-input").value.trim();
  store("token", token);
  start();
});
$("token-button").addEventListener("click", () => askToken());

// ---------------------------------------------------------------- templates

let meta = null;
/** The user's templates: { id, name, description, options }. */
let mine = load("templates", []);
if (!Array.isArray(mine)) mine = [];
/** Which template is open, and the form's working copy of it. */
let selected = load("selected", { kind: "builtin", id: "smoke" });
let draft = null;

const source = () =>
  selected.kind === "mine" ? mine.find((t) => t.id === selected.id) : meta.templates.find((t) => t.id === selected.id);
const clone = (t) => ({ name: t.name, description: t.description, options: { ...t.options } });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dirty = () => !same(draft, clone(source()));

function saveMine() {
  if (!store("templates", mine)) message("Could not save: this browser's storage is blocked or full.", true);
}

function renderLists() {
  const item = (t, kind) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-current", String(selected.kind === kind && selected.id === t.id));
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = t.description || summarize(t.options);
    button.append(t.name, sub);
    button.addEventListener("click", () => select(kind, t.id));
    li.append(button);
    return li;
  };
  $("builtin-list").replaceChildren(...meta.templates.map((t) => item(t, "builtin")));
  $("mine-list").replaceChildren(...mine.map((t) => item(t, "mine")));
  $("mine-empty").hidden = mine.length > 0;
}

function summarize(options) {
  return Object.entries(options)
    .filter(([, v]) => v !== "" && v !== false)
    .map(([k, v]) => (v === true ? k : `${k} ${v}`))
    .join(", ");
}

function select(kind, id) {
  if (draft && source() && dirty() && !confirm("Discard your changes to this template?")) return;
  selected = { kind, id };
  if (!source()) selected = { kind: "builtin", id: meta.templates[0].id };
  store("selected", selected);
  draft = clone(source());
  renderLists();
  renderEditor();
}

function renderEditor() {
  const own = selected.kind === "mine";
  $("name").value = draft.name;
  $("description").value = draft.description;
  $("name").readOnly = $("description").readOnly = !own;
  $("kind").textContent = own ? "Mine" : "Built-in";
  $("save").hidden = !own;
  $("delete").hidden = !own;
  $("clone").textContent = own ? "Duplicate" : "Clone to edit";

  const groups = new Map();
  for (const spec of meta.options) {
    if (!groups.has(spec.group)) groups.set(spec.group, []);
    groups.get(spec.group).push(spec);
  }
  const base = clone(source()).options;
  const fieldsets = [...groups].map(([group, specs]) => {
    const fs = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = group;
    fs.append(legend);
    for (const spec of specs) {
      const field = document.createElement("div");
      field.className = "field";
      if (["steps", "room", "target"].includes(spec.name)) field.classList.add("wide");
      const id = `opt-${spec.name}`;
      const label = document.createElement("label");
      label.htmlFor = id;
      const input = document.createElement("input");
      input.id = id;
      input.name = spec.name;
      input.disabled = !own;
      if (spec.type === "boolean") {
        input.type = "checkbox";
        input.checked = draft.options[spec.name] === true;
        label.append(input, `--${spec.name}`);
      } else {
        input.type = "text";
        input.spellcheck = false;
        input.value = draft.options[spec.name] ?? "";
        input.placeholder = spec.default ?? (spec.name === "target" ? "the Target above" : "");
        label.append(`--${spec.name}`);
      }
      const help = document.createElement("small");
      help.textContent = spec.help;
      field.append(...(spec.type === "boolean" ? [label, help] : [label, input, help]));
      // Unsaved edits show in the accent color.
      field.classList.toggle("changed", (draft.options[spec.name] ?? "") !== (base[spec.name] ?? ""));
      fs.append(field);
    }
    return fs;
  });
  $("form").replaceChildren(...fieldsets);
  renderCommand();
  renderButtons();
}

/** What will be run: the draft, with the Target above when it names none. */
function effectiveOptions() {
  const options = {};
  for (const [k, v] of Object.entries(draft.options)) if (v !== "" && v !== false && v !== undefined) options[k] = v;
  const target = $("target").value.trim();
  if (!options.target && target) options.target = target;
  return options;
}

function renderCommand() {
  const args = Object.entries(effectiveOptions()).flatMap(([k, v]) =>
    v === true ? [`--${k}`] : [`--${k}`, /[\s"']/.test(v) ? JSON.stringify(v) : v],
  );
  $("command").textContent = ["bun tools/loadtest.ts", ...args].join(" ");
}

function renderButtons() {
  const busy = Boolean(currentRun);
  const isDirty = dirty();
  $("run").disabled = busy;
  $("run").title = busy ? "A run is going; stop it first" : "";
  $("save").disabled = !isDirty;
  $("revert").disabled = !isDirty;
}

$("form").addEventListener("input", (e) => {
  const input = e.target;
  if (!input.name) return;
  if (input.type === "checkbox") draft.options[input.name] = input.checked;
  else draft.options[input.name] = input.value;
  const base = source().options[input.name] ?? "";
  input.closest(".field").classList.toggle("changed", (draft.options[input.name] ?? "") !== base);
  renderCommand();
  renderButtons();
});
$("name").addEventListener("input", () => {
  draft.name = $("name").value;
  renderButtons();
});
$("description").addEventListener("input", () => {
  draft.description = $("description").value;
  renderButtons();
});
$("target").addEventListener("input", () => {
  store("target", $("target").value.trim());
  renderCommand();
});

$("save").addEventListener("click", () => {
  const t = mine.find((x) => x.id === selected.id);
  if (!t) return;
  Object.assign(t, clone({ ...draft, name: draft.name.trim() || "Untitled" }));
  saveMine();
  draft = clone(t);
  renderLists();
  renderEditor();
  message("Saved in this browser.");
});

$("clone").addEventListener("click", () => {
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const copy = { id, ...clone(draft), name: `${draft.name} (copy)` };
  mine.push(copy);
  saveMine();
  draft = null; // the edits went into the copy
  select("mine", id);
  $("name").focus();
  $("name").select();
  message("Cloned into My templates; edit away.");
});

$("revert").addEventListener("click", () => {
  draft = clone(source());
  renderEditor();
});

$("delete").addEventListener("click", () => {
  if (!confirm(`Delete "${draft.name}"?`)) return;
  mine = mine.filter((t) => t.id !== selected.id);
  saveMine();
  draft = null;
  select("builtin", meta.templates[0].id);
});

$("copy-command").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("command").textContent);
    message("Command copied.");
  } catch {
    message("Could not copy; select the command instead.", true);
  }
});

let messageTimer;
function message(text, error = false) {
  clearTimeout(messageTimer);
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
  messageTimer = setTimeout(() => ($("message").textContent = ""), error ? 8000 : 3000);
}

// ---------------------------------------------------------------- runs

/** The run going on the server (id), and the one on screen with what we have of it. */
let currentRun = null;
let shown = null;
let pollTimer;

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  try {
    const run = await api("/api/runs", { method: "POST", body: JSON.stringify({ name: draft.name, options: effectiveOptions() }) });
    currentRun = run.id;
    await refreshHistory();
    show(run);
    message("Started.");
  } catch (err) {
    if (err.message !== "unauthorized") message(err.message, true);
  }
  renderButtons();
});

$("stop").addEventListener("click", async () => {
  if (!shown) return;
  $("stop").disabled = true;
  try {
    await api(`/api/runs/${shown.id}/stop`, { method: "POST" });
  } catch (err) {
    message(err.message, true);
  }
});

$("csv").addEventListener("click", async () => {
  if (!shown) return;
  try {
    const blob = await api(`/api/runs/${shown.id}/csv`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `loadtest-${shown.id}-${shown.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    message(err.message, true);
  }
});

$("history").addEventListener("change", async () => {
  const id = Number($("history").value);
  if (!id) return;
  try {
    show(await api(`/api/runs/${id}`));
  } catch (err) {
    message(err.message, true);
  }
});

async function refreshHistory() {
  const runs = await api("/api/runs");
  const select = $("history");
  const options = runs.map((r) => {
    const o = document.createElement("option");
    o.value = r.id;
    const when = new Date(r.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    o.textContent = `#${r.id} ${r.name} · ${when} · ${r.status}`;
    return o;
  });
  if (!options.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "No runs yet";
    options.push(o);
  }
  select.replaceChildren(...options);
  if (shown) select.value = shown.id;
  return runs;
}

/** Put a run on screen (a full fetch: events from 0) and follow it while it goes. */
function show(run) {
  clearTimeout(pollTimer);
  shown = { ...run, rows: [], lines: [], header: "" };
  absorb(run);
  $("history").value = run.id;
  renderRun();
  if (isLive(run)) pollTimer = setTimeout(poll, POLL_MS);
}

const isLive = (run) => run.status === "running" || run.status === "stopping";

function absorb(run) {
  Object.assign(shown, {
    status: run.status,
    summary: run.summary,
    endedAt: run.endedAt,
    hasCsv: run.hasCsv,
    next: run.next,
    endless: run.endless,
    resumedFrom: run.resumedFrom,
  });
  for (const e of run.events) {
    if (e.type === "row") shown.rows.push(e.values);
    else if (e.type === "header") shown.header = e.text;
    shown.lines.push(e);
  }
}

async function poll() {
  if (!shown) return;
  const id = shown.id;
  try {
    const run = await api(`/api/runs/${id}?since=${shown.next}`);
    if (shown?.id !== id) return;
    absorb(run);
    renderRun();
    if (!isLive(run)) {
      if (currentRun === id) currentRun = null;
      renderButtons();
      refreshHistory();
      return;
    }
  } catch (err) {
    if (err.message === "unauthorized") return;
  }
  pollTimer = setTimeout(poll, POLL_MS);
}

function renderRun() {
  const run = shown;
  $("status").textContent = run.status;
  $("status").className = `status ${run.status}`;
  $("stop").hidden = !isLive(run);
  $("stop").disabled = run.status === "stopping";
  $("csv").hidden = !run.hasCsv;
  $("summary").textContent = run.summary;
  const live = isLive(run);
  const notes = [];
  if (run.endless && live) notes.push("Keeps its bots in until you stop it. Closing this page does not stop it; open the page again to come back to it.");
  if (run.resumedFrom) notes.push(`Started again after the load test server restarted; first started ${new Date(run.resumedFrom).toLocaleString()}.`);
  $("run-note").textContent = notes.join(" ");
  document.title = live ? `● ${run.name} · Daystar Load Test` : "Daystar Load Test";
  const secs = Math.round(((run.endedAt ?? Date.now()) - (run.resumedFrom ?? run.startedAt)) / 1000);
  const h = Math.floor(secs / 3600);
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(h ? 2 : 1, "0");
  $("elapsed").textContent = `${h ? `${h}:` : ""}${mm}:${String(secs % 60).padStart(2, "0")}`;
  renderCharts(run.rows);
  renderTable(run.rows);
  const pre = $("output");
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.replaceChildren(
    document.createTextNode(`$ ${run.command}\n`),
    ...run.lines.map((e) => {
      const span = document.createElement("span");
      if (e.type === "warn") span.className = "warn";
      span.textContent = e.text + "\n";
      return span;
    }),
  );
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function renderTable(rows) {
  const thead = $("rows").tHead;
  if (!thead.rows.length) {
    const tr = document.createElement("tr");
    for (const [key, label] of COLUMNS) {
      const th = document.createElement("th");
      th.textContent = label;
      if (key === "verdict") th.className = "verdict";
      tr.append(th);
    }
    thead.append(tr);
  }
  const body = $("rows").tBodies[0];
  const wrap = body.closest(".table-wrap");
  const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 4;
  body.replaceChildren(
    ...rows.map((r) => {
      const tr = document.createElement("tr");
      for (const [key] of COLUMNS) {
        const td = document.createElement("td");
        let v = r[key];
        if (key === "srv_cpu" && typeof v === "number") v = `${Math.round(v * 100)}%`;
        td.textContent = v === "" || v === null || v === undefined || Number.isNaN(v) ? "-" : String(v);
        if (key === "verdict") td.className = `verdict ${String(v).startsWith("ok") ? "ok" : "fail"}`;
        tr.append(td);
      }
      return tr;
    }),
  );
  if (atBottom) wrap.scrollTop = wrap.scrollHeight;
}

function renderCharts(rows) {
  const svgNs = "http://www.w3.org/2000/svg";
  $("charts").replaceChildren(
    ...CHARTS.map((c) => {
      const values = rows.map((r) => (typeof r[c.key] === "number" ? r[c.key] * (c.scale ?? 1) : NaN));
      const known = values.filter((v) => !Number.isNaN(v));
      const card = document.createElement("div");
      card.className = "chart";
      const label = document.createElement("div");
      label.className = "label";
      const value = document.createElement("span");
      value.className = "value";
      const last = known.at(-1);
      value.textContent = last === undefined ? "-" : `${Math.round(last * 10) / 10}${c.unit}`;
      label.append(c.label, value);
      const svg = document.createElementNS(svgNs, "svg");
      svg.setAttribute("viewBox", "0 0 100 40");
      svg.setAttribute("preserveAspectRatio", "none");
      if (known.length > 1) {
        const max = Math.max(...known) || 1;
        const points = values
          .map((v, i) => (Number.isNaN(v) ? null : `${(i / (values.length - 1)) * 100},${38 - (v / max) * 36}`))
          .filter(Boolean)
          .join(" ");
        const line = document.createElementNS(svgNs, "polyline");
        line.setAttribute("points", points);
        line.setAttribute("fill", "none");
        line.setAttribute("stroke", "var(--accent)");
        line.setAttribute("stroke-width", "1.5");
        line.setAttribute("vector-effect", "non-scaling-stroke");
        svg.append(line);
      }
      card.append(label, svg);
      return card;
    }),
  );
}

// ---------------------------------------------------------------- start

async function start() {
  if (!token) return askToken();
  try {
    meta = await api("/api/meta");
  } catch (err) {
    if (err.message !== "unauthorized") askToken(err.message);
    return;
  }
  $("target").value = load("target", meta.target);
  $("health-note").textContent = meta.healthToken ? "" : "no HEALTH_TOKEN on the server: remote server stats may be missing";
  currentRun = meta.current;
  draft = null;
  select(selected.kind, selected.id);
  const runs = await refreshHistory();
  const latest = runs.find((r) => r.id === currentRun) ?? runs[0];
  if (latest) show(await api(`/api/runs/${latest.id}`));
}

start();
