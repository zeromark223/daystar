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

/**
 * Serve the built client. Unknown paths without an extension fall back to
 * index.html so client-side routes like /r/<room-id> work on reload.
 */
export function createStaticHandler(root: string) {
  return async (req: Request): Promise<Response> => {
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
