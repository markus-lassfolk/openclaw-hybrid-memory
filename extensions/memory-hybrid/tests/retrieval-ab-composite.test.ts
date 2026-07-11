/**
 * Living-memory B3: the composite-score v1 vs v2(+MMR) A/B over the deterministic gold set.
 * applyRetrievalV2 runs only on the ambient path, so the explicit-recall harness can't see it —
 * this test invokes it DIRECTLY over identical FTS candidates per arm and scores both. The
 * grep-able "[retrieval-ab]" line documents the measurement; the guard asserts arm B never
 * regresses nDCG by more than 0.02 vs arm A (the flip itself is criterion-gated: B ≥ A on both
 * nDCG@10 AND P@5).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARM_A, ARM_B } from "../benchmark/retrieval-eval/ab-config.js";
import { buildFixtureFacts, buildGoldQueries } from "../benchmark/retrieval-eval/gold-set.js";
import { summarize } from "../benchmark/retrieval-eval/score.js";
import { searchFts } from "../services/fts-search.js";
import { applyRetrievalV2, type RetrievalV2Config } from "../services/retrieval-v2.js";
import { _resetWalCircuitBreakerForTesting } from "../services/wal-helpers.js";
import { resetPluginRegistrationStateForTests, runtimeRef } from "../setup/register-plugin.js";
import type { SearchResult } from "../types/memory.js";
import {
  type FullStackApi,
  getFullStackConfig,
  makeFullStackApi,
  registerFullPlugin,
} from "./helpers/comprehensive-e2e-harness.js";

vi.mock("../lifecycle/stage-capture.js", () => ({
  runCaptureStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/worker/narratives.js", () => ({
  buildDailyNarrative: vi.fn().mockResolvedValue(undefined),
}));

describe("retrieval A/B: composite v1 baseline vs v2 + MMR (living-memory B3)", () => {
  let tmpDir: string;
  let api: FullStackApi;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "retrieval-ab-"));
    api = makeFullStackApi(tmpDir);
    process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY = "reuse-databases";
    _resetWalCircuitBreakerForTesting();
    resetPluginRegistrationStateForTests();
  });

  afterEach(async () => {
    try {
      await api.stopService();
    } catch {
      /* non-fatal */
    }
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
    resetPluginRegistrationStateForTests();
    delete process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY;
  });

  it("measures both arms over the gold set; arm B must not regress nDCG > 0.02", async () => {
    registerFullPlugin(
      api,
      getFullStackConfig(tmpDir, {
        retrieval: { strategies: ["fts5"] },
        graph: { enabled: true, autoLink: false, useInRecall: false, strengthenOnRecall: false },
        autoRecall: { enabled: true, limit: 5, maxTokens: 600, minScore: 0.01, injectionFormat: "full" },
        store: { fuzzyDedupe: false, classifyBeforeWrite: false },
      }),
    );
    await runtimeRef.value?.bootstrapAsyncInit?.catch(() => {});
    const factsDb = runtimeRef.value!.factsDb;
    const idByFixtureKey = new Map<string, string>();
    for (const fact of buildFixtureFacts()) {
      const stored = factsDb.store({
        text: fact.text,
        category: fact.category,
        importance: fact.importance,
        entity: fact.entity,
        key: null,
        value: null,
        source: "retrieval-ab",
        tags: [],
      } as never);
      idByFixtureKey.set(fact.fixtureKey, stored.id);
    }

    const runArm = async (config: RetrievalV2Config) => {
      const perQuery: Array<{ ranked: string[]; relevant: ReadonlySet<string> }> = [];
      for (const gold of buildGoldQueries()) {
        // Identical FTS candidates per arm; rank → deterministic descending score.
        const fts = searchFts(factsDb.getRawDb(), gold.query, { limit: 20 });
        const candidates: SearchResult[] = fts.map((r, i) => ({
          entry: factsDb.getById(r.factId)!,
          score: 1 / (1 + i),
          backend: "sqlite" as const,
        }));
        const outcome = await applyRetrievalV2({
          query: gold.query,
          results: candidates,
          ftsResults: candidates,
          getEntry: (id) => factsDb.getById(id),
          config,
          recallId: `ab-${gold.query.slice(0, 12)}`,
          factsDb, // empty recall_events ⇒ co-activation/cross-domain are deterministic zeros
          recordBypassTelemetry: false,
        });
        perQuery.push({
          ranked: outcome.results.map((r) => r.entry.id),
          relevant: new Set(gold.relevant.map((k) => idByFixtureKey.get(k)!)),
        });
      }
      return summarize(perQuery);
    };

    const armA = await runArm(ARM_A);
    const armB = await runArm(ARM_B);

    const measurement =
      `[retrieval-ab] armA(v1) P@5=${armA.meanPrecisionAt5.toFixed(3)} R@10=${armA.meanRecallAt10.toFixed(3)} nDCG@10=${armA.meanNdcgAt10.toFixed(3)} | ` +
      `armB(v2+mmr) P@5=${armB.meanPrecisionAt5.toFixed(3)} R@10=${armB.meanRecallAt10.toFixed(3)} nDCG@10=${armB.meanNdcgAt10.toFixed(3)} | ` +
      `flip criterion (B≥A on nDCG AND P@5): ${armB.meanNdcgAt10 >= armA.meanNdcgAt10 && armB.meanPrecisionAt5 >= armA.meanPrecisionAt5 ? "PASS" : "FAIL"}`;
    console.log(measurement);
    // Reporters buffer worker console output — persist the measurement where operators/CI can
    // always find it, alongside the OS temp dir used by every other fixture in this suite.
    writeFileSync(join(tmpdir(), "hybrid-mem-retrieval-ab-latest.txt"), `${measurement}\n`);

    // Non-regression guard, not the flip criterion: a v2/MMR change that tanks ranking fails CI.
    expect(armB.meanNdcgAt10).toBeGreaterThanOrEqual(armA.meanNdcgAt10 - 0.02);
    // Both arms must actually rank something.
    expect(armA.queries).toBe(30);
    expect(armB.queries).toBe(30);
    expect(armA.meanRecallAt10).toBeGreaterThan(0.9);
  }, 120_000);
});
