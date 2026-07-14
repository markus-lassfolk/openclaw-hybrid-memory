/**
 * Tests for the serendipity digest + Level-4 sweep (Issue #2119).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SerendipityStore } from "../backends/serendipity-store.js";
import { parseConfig } from "../config/parsers/index.js";
import { buildSerendipityDigestReport, renderSerendipityDigestMarkdown } from "../services/serendipity-digest.js";
import { runSerendipitySweep } from "../services/serendipity-sweep-cron.js";
import type { HybridMemoryConfig } from "../config.js";

let tmpDir: string;
let store: SerendipityStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "serendipity-digest-test-"));
  store = new SerendipityStore(join(tmpDir, "serendipity.db"));
  store.create({ title: "a", description: "d", findingType: "packaging_defect", suggestedAction: "fix_now" });
  store.create({ title: "b", description: "d", findingType: "documentation_mismatch", suggestedAction: "remember" });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("serendipity digest", () => {
  it("builds counts and an actionable backlog", () => {
    const report = buildSerendipityDigestReport({ store, sinceDays: 30, level: 4 });
    expect(report.totals.total).toBe(2);
    expect(report.backlog.actionable).toBe(1); // only the fix_now finding is actionable
    expect(report.backlog.top[0]?.resolveCommand).toContain("serendipity resolve");
  });

  it("renders markdown with headers", () => {
    const md = renderSerendipityDigestMarkdown(buildSerendipityDigestReport({ store, sinceDays: 30, level: 4 }));
    expect(md).toContain("# Serendipity digest");
    expect(md).toContain("Actionable backlog");
  });
});

function cfgWith(overrides: Record<string, unknown>): HybridMemoryConfig {
  return parseConfig({
    embedding: { provider: "ollama", model: "nomic-embed-text" },
    serendipityProtocol: { enabled: true, ...overrides },
  }) as HybridMemoryConfig;
}

describe("serendipity sweep", () => {
  it("skips when the sweep is disabled", () => {
    const summary = runSerendipitySweep({ cfg: cfgWith({ sweep: { enabled: false } }), store });
    expect(summary.status).toBe("skipped");
    expect(summary.skipReason).toBe("sweep_disabled");
  });

  it("skips when the store is unavailable", () => {
    const summary = runSerendipitySweep({ cfg: cfgWith({ sweep: { enabled: true } }), store: null });
    expect(summary.skipReason).toBe("store_unavailable");
  });

  it("skips when the resolved level is below the sweep minimum", () => {
    const summary = runSerendipitySweep({
      cfg: cfgWith({ defaultLevel: 2, sweep: { enabled: true, minLevel: 4 } }),
      store,
    });
    expect(summary.skipReason).toBe("below_min_level");
  });

  it("runs, prunes expired, and reports actionable items without dispatching by default", () => {
    const expired = store.create({
      title: "expired",
      description: "d",
      findingType: "packaging_defect",
      suggestedAction: "fix_now",
    });
    store.update(expired.id, { expiresAt: new Date(Date.now() - 86_400_000).toISOString() });
    const summary = runSerendipitySweep({
      cfg: cfgWith({ defaultLevel: 4, sweep: { enabled: true, minLevel: 4, dispatch: false } }),
      store,
    });
    expect(summary.status).toBe("ok");
    expect(summary.prunedExpired).toBe(1);
    expect(summary.actionable).toBe(1);
    expect(summary.dispatchCandidates).toHaveLength(0);
  });

  it("surfaces dispatch candidates when dispatch is enabled", () => {
    const summary = runSerendipitySweep({
      cfg: cfgWith({ defaultLevel: 4, sweep: { enabled: true, minLevel: 4, dispatch: true } }),
      store,
    });
    expect(summary.status).toBe("ok");
    expect(summary.dispatchCandidates.length).toBeGreaterThan(0);
  });
});
