/**
 * Tests for the serendipity digest + Level-4 sweep (Issue #2119).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SerendipityStore } from "../backends/serendipity-store.js";
import { parseConfig } from "../config/parsers/index.js";
import { _testing } from "../index.js";
import {
  buildPendingReviewDigestReport,
  renderPendingReviewDigestMarkdown,
} from "../services/pending-review-digest.js";
import { buildSerendipityDigestReport, renderSerendipityDigestMarkdown } from "../services/serendipity-digest.js";
import { runSerendipitySweep } from "../services/serendipity-sweep-cron.js";
import { type HybridMemoryConfig, hybridConfigSchema } from "../config.js";

const { FactsDB } = _testing;

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
  it("skips when the sweep is disabled", async () => {
    const summary = await runSerendipitySweep({ cfg: cfgWith({ sweep: { enabled: false } }), store });
    expect(summary.status).toBe("skipped");
    expect(summary.skipReason).toBe("sweep_disabled");
  });

  it("skips when the store is unavailable", async () => {
    const summary = await runSerendipitySweep({ cfg: cfgWith({ sweep: { enabled: true } }), store: null });
    expect(summary.skipReason).toBe("store_unavailable");
  });

  it("skips when the resolved level is below the sweep minimum", async () => {
    const summary = await runSerendipitySweep({
      cfg: cfgWith({ defaultLevel: 2, sweep: { enabled: true, minLevel: 4 } }),
      store,
    });
    expect(summary.skipReason).toBe("below_min_level");
  });

  it("runs, prunes expired, and reports actionable items without dispatching by default", async () => {
    const expired = store.create({
      title: "expired",
      description: "d",
      findingType: "packaging_defect",
      suggestedAction: "fix_now",
    });
    store.update(expired.id, { expiresAt: new Date(Date.now() - 86_400_000).toISOString() });
    const summary = await runSerendipitySweep({
      cfg: cfgWith({ defaultLevel: 4, sweep: { enabled: true, minLevel: 4, dispatch: false } }),
      store,
    });
    expect(summary.status).toBe("ok");
    expect(summary.prunedExpired).toBe(1);
    expect(summary.actionable).toBe(1);
    expect(summary.dispatched).toHaveLength(0);
  });

  it("degrades to report-only when dispatch is on but no promotion deps are provided", async () => {
    const summary = await runSerendipitySweep({
      cfg: cfgWith({ defaultLevel: 4, sweep: { enabled: true, minLevel: 4, dispatch: true } }),
      store,
    });
    expect(summary.status).toBe("ok");
    expect(summary.dispatched).toHaveLength(0);
  });
});

describe("serendipity section in the pending-review digest", () => {
  it("adds a backlog section only when a store is supplied", () => {
    const dir = mkdtempSync(join(tmpdir(), "serendipity-pending-digest-"));
    const sqlitePath = join(dir, "facts.db");
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "ollama", model: "nomic-embed-text" },
      sqlitePath,
      lanceDbPath: join(dir, "lancedb"),
      credentials: { enabled: false },
      wal: { enabled: false },
      personaProposals: { enabled: false },
      verification: { enabled: false },
      provenance: { enabled: false },
      nightlyCycle: { enabled: false },
      serendipityProtocol: { enabled: true },
    }) as HybridMemoryConfig;
    const factsDb = new FactsDB(sqlitePath);
    const sstore = new SerendipityStore(join(dir, "serendipity.db"));
    sstore.create({
      title: "backlog item",
      description: "d",
      findingType: "packaging_defect",
      suggestedAction: "fix_now",
    });
    try {
      const withStore = buildPendingReviewDigestReport({ cfg, factsDb: factsDb as any, serendipityStore: sstore });
      expect(withStore.serendipity?.actionableBacklog).toBe(1);
      expect(renderPendingReviewDigestMarkdown(withStore)).toContain("Serendipity backlog");
      const withoutStore = buildPendingReviewDigestReport({ cfg, factsDb: factsDb as any });
      expect(withoutStore.serendipity).toBeUndefined();
    } finally {
      factsDb.close();
      sstore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
