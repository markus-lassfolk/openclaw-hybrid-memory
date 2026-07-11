// @ts-nocheck
/**
 * Browser smoke for the Memory Graph SPA against the REAL stack: real dashboard server, real
 * FactsDB (node:sqlite), the BUILT SPA from graph-app/dist, and a real headless Chromium.
 *
 * Asserts the three integration seams unit tests structurally can't cover:
 *   1. the built assets serve + render (canvas up, node count in the header),
 *   2. recall HISTORY hydrates the activity feed from recall_events (recentRecallEvents query),
 *   3. a server-side write reaches the page over live SSE (memory-events → pubsub → graphql-sse).
 *
 * Gated behind RUN_GRAPH_E2E=1 (CI job "graph-e2e" and manual local runs) so the normal suite
 * never launches a browser. Skips itself with a reason when the SPA build or a Chromium binary
 * is missing.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { createDashboardServer } from "../routes/dashboard-server.js";
import { recordRecallEvent } from "../services/recall-events.js";

const { FactsDB, VectorDB } = _testing;

const DIST_INDEX = new URL("../graph-app/dist/index.html", import.meta.url).pathname;

/** First Chromium-compatible binary we can find (env override → this container → GH runners). */
function findChromium(): string | null {
  const candidates = [
    process.env.GRAPH_E2E_CHROMIUM,
    "/opt/pw-browsers/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

const enabled = process.env.RUN_GRAPH_E2E === "1";
const chromiumPath = enabled ? findChromium() : null;
const distBuilt = enabled ? existsSync(DIST_INDEX) : false;
const runnable = enabled && chromiumPath != null && distBuilt;

if (enabled && !runnable) {
  // Make the skip reason visible in CI logs instead of silently passing.
  console.error(
    `graph-app e2e smoke SKIPPED: ${!distBuilt ? "graph-app/dist not built (run npm run build:graph-app). " : ""}${
      chromiumPath == null ? "No Chromium binary found (set GRAPH_E2E_CHROMIUM)." : ""
    }`,
  );
}

const describeE2E = runnable ? describe : describe.skip;

describeE2E("Memory Graph SPA browser smoke (real server + built SPA + Chromium)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let dashboard: Awaited<ReturnType<typeof createDashboardServer>>;
  let browser: import("playwright-core").Browser;
  let baseUrl: string;
  let teaFactId: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "graph-e2e-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    const vectorDb = new VectorDB(join(tmpDir, "lance"), 4);

    // A small constellation: 4 linked facts + 1 orphan.
    const seed = (text: string) =>
      factsDb.store({ text, category: "fact", importance: 0.7, source: "e2e", tags: ["e2e"] }).id;
    const a = seed("The warp core runs on dilithium crystals");
    const b = seed("Dilithium crystals are mined on Coridan");
    const c = seed("The warp core powers the impulse drive");
    teaFactId = seed("Chief engineer prefers Earl Grey tea");
    factsDb.createLink(a, b, "RELATED_TO", 0.9);
    factsDb.createLink(a, c, "PART_OF", 0.8);

    // Pre-existing recall history → the feed must hydrate this WITHOUT any live event.
    recordRecallEvent(factsDb.getRawDb(), {
      occurredAtSec: Math.floor(Date.now() / 1000) - 60,
      sessionKey: "e2e-session",
      query: "warp drive calibration",
      factIds: [a, c],
      hit: true,
      source: "tool",
      scores: { [a]: 0.9, [c]: 0.7 },
    });

    // Free ephemeral port, then start the real dashboard server on it.
    const { createServer } = await import("node:http");
    const probe = createServer();
    const port: number = await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const addr = probe.address();
        probe.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
      });
    });
    dashboard = await createDashboardServer(
      {
        factsDb,
        vectorDb,
        resolvedSqlitePath: join(tmpDir, "facts.db"),
        resolvedLancePath: join(tmpDir, "lance"),
      },
      port,
    );
    baseUrl = `http://127.0.0.1:${port}`;

    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    try {
      await dashboard?.close?.(); // may be sync (returns void) — don't assume a Promise
    } catch {
      /* ignore */
    }
    try {
      factsDb?.close?.();
    } catch {
      /* ignore */
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders the constellation, hydrates recall history, and receives live SSE updates", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(`${baseUrl}/graph`, { waitUntil: "domcontentloaded" });

    // 1. The built SPA renders: canvas mounted, header counts the seeded stars.
    await page.waitForSelector("canvas", { timeout: 15_000 });
    await page.waitForFunction(() => /\d+ stars/.test(document.body.innerText), null, { timeout: 15_000 });
    expect(await page.evaluate(() => document.body.innerText)).toMatch(/4 stars/);

    // 2. History hydration: the pre-seeded recall_events row reaches the feed via
    //    recentRecallEvents — no live recall has fired in this test yet.
    await page.waitForFunction(() => document.body.innerText.includes("recall · warp drive calibration"), null, {
      timeout: 10_000,
    });

    // 3. Live SSE: a server-side store lands in the activity feed AND as a 5th star.
    factsDb.store({
      text: "Live smoke fact stored while the page watches",
      category: "decision",
      importance: 0.8,
      source: "e2e-live",
      tags: ["e2e"],
    });
    await page.waitForFunction(() => document.body.innerText.includes("Live smoke fact"), null, {
      timeout: 15_000,
    });
    await page.waitForFunction(() => /5 stars/.test(document.body.innerText), null, { timeout: 15_000 });

    // A live recall pulses through the same transport (memory-events → pubsub → SSE). It must
    // reference a real fact — the recallOccurred subscription deliberately drops recalls whose
    // visible hit set is empty.
    recordRecallEvent(factsDb.getRawDb(), {
      sessionKey: "e2e-session",
      query: "tea preferences",
      factIds: [teaFactId],
      hit: true,
      source: "auto-recall",
      scores: { [teaFactId]: 0.95 },
    });
    await page.waitForFunction(() => document.body.innerText.includes("recall · tea preferences"), null, {
      timeout: 15_000,
    });

    expect(pageErrors).toEqual([]);
    await page.close();
  }, 90_000);
});
