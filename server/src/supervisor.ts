/**
 * Container entry point. CLUSTER_SERVERS=0 (default) runs one standalone game
 * server; N > 0 runs the agent plus N game servers as child processes
 * (docs/cluster.md), restarting any that exit.
 *
 * Environment:
 *   PORT                        agent (or standalone server) port, default 3000
 *   CLUSTER_SERVERS             number of game servers, default 0 (standalone)
 *   CLUSTER_SECRET              shared HMAC key; generated per container when unset
 *   SERVER_BASE_PORT            first game server port, default PORT + 1
 *   SERVER_CAPACITY             players per server at 100% load, default 2000
 *   SERVER_PUBLIC_URL_TEMPLATE  client-facing URL, {id} and {port} are replaced,
 *                               default ws://localhost:{port}/ws
 */
import { spawn, type Subprocess } from "bun";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const SERVERS = Number(process.env.CLUSTER_SERVERS ?? 0);

interface Child {
  name: string;
  entry: string;
  env: Record<string, string>;
  proc?: Subprocess;
  restarts: number;
}

let stopping = false;

/** Forward a child's output line by line with a "[name] " prefix. */
async function pipe(name: string, stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) out.write(`[${name}] ${line}\n`);
  }
  if (rest) out.write(`[${name}] ${rest}\n`);
}

function start(child: Child): void {
  const proc = spawn([process.execPath, child.entry], {
    env: { ...process.env, ...child.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  child.proc = proc;
  void pipe(child.name, proc.stdout, process.stdout);
  void pipe(child.name, proc.stderr, process.stderr);
  void proc.exited.then((code) => {
    if (stopping) return;
    // Back off up to 10 s so a crash loop does not spin; reset after a healthy minute.
    const delay = Math.min(10_000, 1000 * 2 ** Math.min(child.restarts, 4));
    child.restarts++;
    console.error(`[supervisor] ${child.name} exited (code ${code}); restarting in ${delay} ms`);
    setTimeout(() => start(child), delay);
    setTimeout(() => (child.restarts = 0), 60_000);
  });
}

const children: Child[] = [];

if (SERVERS <= 0) {
  children.push({ name: "server", entry: here("./main.ts"), env: {}, restarts: 0 });
} else {
  const secret = process.env.CLUSTER_SECRET || randomBytes(32).toString("base64url");
  const basePort = Number(process.env.SERVER_BASE_PORT ?? PORT + 1);
  const template = process.env.SERVER_PUBLIC_URL_TEMPLATE ?? "ws://localhost:{port}/ws";
  const capacity = process.env.SERVER_CAPACITY ?? "2000";
  children.push({
    name: "agent",
    entry: here("./agent/main.ts"),
    env: { PORT: String(PORT), CLUSTER_SECRET: secret },
    restarts: 0,
  });
  for (let id = 1; id <= SERVERS; id++) {
    const port = basePort + id - 1;
    children.push({
      name: `s${id}`,
      entry: here("./main.ts"),
      env: {
        PORT: String(port),
        CLUSTER_SECRET: secret,
        SERVER_ID: String(id),
        SERVER_CAPACITY: capacity,
        SERVER_PUBLIC_URL: template.replaceAll("{id}", String(id)).replaceAll("{port}", String(port)),
        SERVER_MESH_URL: `ws://127.0.0.1:${port}/mesh`,
        AGENT_URL: `ws://127.0.0.1:${PORT}/internal`,
      },
      restarts: 0,
    });
  }
  console.log(`[supervisor] cluster: agent on ${PORT}, ${SERVERS} servers on ${basePort}..${basePort + SERVERS - 1}`);
}

for (const child of children) start(child);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    for (const child of children) child.proc?.kill(signal);
    Promise.all(children.map((c) => c.proc?.exited)).then(() => process.exit(0));
  });
}
