/**
 * Static file server for the built Memory Graph SPA (graph-app/dist), mounted under /graph.
 *
 * Serving is hardened against path traversal: the resolved path must stay inside the dist root.
 * Unknown non-asset paths fall back to index.html (client-side routing). If the app hasn't been
 * built yet (dev before `npm run build:graph-app`), a friendly placeholder is returned instead of
 * a 500 so the dashboard stays usable.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { findPluginRoot } from "../../utils/plugin-root.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

let cachedDistDir: string | null = null;

/** Resolve graph-app/dist under the plugin root (bundled or source), cached. Null if unresolvable. */
function graphAppDistDir(): string | null {
  if (cachedDistDir !== null) return cachedDistDir;
  try {
    cachedDistDir = join(findPluginRoot(import.meta.url), "graph-app", "dist");
  } catch {
    cachedDistDir = "";
  }
  return cachedDistDir || null;
}

const NOT_BUILT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Memory Graph — not built</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;padding:3rem;line-height:1.6}
code{background:#1a1d27;padding:.2em .4em;border-radius:4px}</style></head>
<body><h1>Memory Graph app not built</h1>
<p>The SPA bundle was not found. Build it from the plugin directory:</p>
<pre><code>cd graph-app &amp;&amp; npm ci &amp;&amp; npm run build</code></pre>
<p>(Or run <code>npm run build</code> at the plugin root, which builds the graph-app too.)</p></body></html>`;

function sendFile(res: ServerResponse, absPath: string, immutable: boolean): void {
  const ext = extname(absPath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  const body = readFileSync(absPath);
  const cacheControl = immutable ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": cacheControl });
  res.end(body);
}

/**
 * Serve the SPA for a `/graph` or `/graph/*` request. Returns true when the request was handled
 * (always true for matching paths). Vite emits hashed, immutable assets under `assets/`.
 */
export function serveGraphApp(pathname: string, res: ServerResponse): boolean {
  const distDir = graphAppDistDir();
  const indexPath = distDir ? join(distDir, "index.html") : null;

  // App not built (or root unresolvable) → friendly placeholder, never a 500.
  if (!distDir || !indexPath || !existsSync(indexPath)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(NOT_BUILT_HTML);
    return true;
  }

  // Strip the /graph prefix to get the requested asset path.
  const rel = pathname.replace(/^\/graph\/?/, "");

  // SPA shell: bare /graph, /graph/, or any extensionless (client-route) path → index.html.
  if (rel === "" || extname(rel) === "") {
    sendFile(res, indexPath, false);
    return true;
  }

  // Resolve + confine to the dist root (path-traversal guard).
  const resolved = normalize(join(distDir, rel));
  const distPrefix = distDir.endsWith(sep) ? distDir : distDir + sep;
  if (!resolved.startsWith(distPrefix)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return true;
  }

  if (existsSync(resolved) && statSync(resolved).isFile()) {
    // Hashed build assets under assets/ are content-addressed → safe to cache immutably.
    const immutable = resolved.startsWith(join(distDir, "assets") + sep);
    sendFile(res, resolved, immutable);
    return true;
  }

  // Missing asset with an extension → 404 (don't masquerade a missing .js as HTML).
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
  return true;
}
