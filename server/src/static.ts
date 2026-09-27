import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const NOT_BUILT_HINT = "The web client is not built yet: run `bun install && bun run build`, then restart the server.";

/** True when `root` holds a built client (vite build output). */
export function clientIsBuilt(root: string): boolean {
  return existsSync(join(root, "index.html"));
}

/** Warn at startup instead of silently answering 404 to every page. */
export function warnIfClientMissing(root: string): void {
  if (!clientIsBuilt(root)) console.warn(`warning: ${NOT_BUILT_HINT} (looked in ${root})`);
}

/**
 * Serve the built client. Unknown paths without an extension fall back to
 * index.html so client-side routes like /r/<room-id> work on reload.
 */
export function createStaticHandler(root: string) {
  return async (req: Request): Promise<Response> => {
    if (!clientIsBuilt(root)) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Daystar</title><body style="font:16px system-ui;background:#04050c;color:#e8ecff;padding:40px"><h1>Almost there</h1><p>${NOT_BUILT_HINT.replace(/`([^`]+)`/g, "<code>$1</code>")}</p></body>`,
        { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const filePath = normalize(join(root, pathname));
    if (!filePath.startsWith(root + sep) && filePath !== root) return new Response(null, { status: 403 });

    let target = filePath;
    let info = await stat(target).catch(() => null);
    if (info?.isDirectory()) {
      target = join(target, "index.html");
      info = await stat(target).catch(() => null);
    }
    if (!info && !extname(pathname)) {
      target = join(root, "index.html");
      info = await stat(target).catch(() => null);
    }
    if (!info) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });

    // Vite emits content-hashed files under /assets-build; everything else revalidates.
    const immutable = pathname.startsWith("/assets-build/");
    const headers = {
      "content-type": MIME[extname(target)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (req.method === "HEAD") return new Response(null, { headers: { ...headers, "content-length": String(info.size) } });
    return new Response(await readFile(target), { headers });
  };
}
