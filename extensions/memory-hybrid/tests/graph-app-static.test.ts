import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serveGraphApp } from "../routes/dashboard/graph-app-static.js";
import { findPluginRoot } from "../utils/plugin-root.js";

/** Minimal ServerResponse capture for unit-testing the static handler. */
function mockRes() {
  const captured = { status: 0, headers: {} as Record<string, string>, body: "" as string | Buffer };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) captured.headers = headers;
      return res;
    },
    end(body?: string | Buffer) {
      if (body != null) captured.body = body;
      return res;
    },
  };
  return { res: res as unknown as import("node:http").ServerResponse, captured };
}

const distBuilt = existsSync(join(findPluginRoot(import.meta.url), "graph-app", "dist", "index.html"));

describe("serveGraphApp static handler", () => {
  it("rejects path traversal outside the dist root with 403", () => {
    const { res, captured } = mockRes();
    const handled = serveGraphApp("/graph/../../package.json", res);
    expect(handled).toBe(true);
    // Either the traversal guard (403) or — if the app isn't built — the placeholder (200), never a
    // real file outside dist. When built, it must be 403.
    if (distBuilt) {
      expect(captured.status).toBe(403);
    } else {
      expect(captured.status).toBe(200);
      expect(String(captured.body)).toContain("not built");
    }
  });

  it("serves the SPA shell (HTML) for the bare /graph route", () => {
    const { res, captured } = mockRes();
    serveGraphApp("/graph", res);
    expect(captured.status).toBe(200);
    expect(captured.headers["Content-Type"]).toContain("text/html");
    expect(String(captured.body).toLowerCase()).toContain("<!doctype html");
  });

  it("falls back to the SPA shell for extensionless client routes", () => {
    const { res, captured } = mockRes();
    serveGraphApp("/graph/some/client/route", res);
    expect(captured.status).toBe(200);
    expect(captured.headers["Content-Type"]).toContain("text/html");
  });

  it("returns 404 for a missing asset with an extension (when built)", () => {
    if (!distBuilt) return;
    const { res, captured } = mockRes();
    serveGraphApp("/graph/assets/does-not-exist-9f9f9f.js", res);
    expect(captured.status).toBe(404);
  });

  it("serves a real hashed JS asset with an immutable cache header (when built)", () => {
    if (!distBuilt) return;
    const assetsDir = join(findPluginRoot(import.meta.url), "graph-app", "dist", "assets");
    const jsAsset = readdirSync(assetsDir).find((f) => f.endsWith(".js"));
    expect(jsAsset).toBeTruthy();
    const { res, captured } = mockRes();
    serveGraphApp(`/graph/assets/${jsAsset}`, res);
    expect(captured.status).toBe(200);
    expect(captured.headers["Content-Type"]).toContain("javascript");
    expect(captured.headers["Cache-Control"]).toContain("immutable");
  });
});
