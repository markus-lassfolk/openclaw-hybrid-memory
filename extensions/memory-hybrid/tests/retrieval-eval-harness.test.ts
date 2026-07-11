/**
 * Retrieval-quality regression floor (P0 of the living-memory plan).
 *
 * Runs the REAL memory_recall tool (full register() stack, deterministic fts5 strategy — no
 * LLM/embedding dependencies) over a fixed 200-fact fixture with 30 gold queries, computes
 * P@5 / R@10 / nDCG@10, and asserts they stay above pinned floors. Any ranking change (RRF
 * fusion, post-RRF adjustments, thresholds, decay interactions) that degrades retrieval fails
 * here instead of silently shipping. A smaller sample also gates the AUTO-recall (ambient
 * injection) path. Metrics are logged so before/after comparisons are one grep away.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFixtureFacts, buildGoldQueries } from "../benchmark/retrieval-eval/gold-set.js";
import { summarize } from "../benchmark/retrieval-eval/score.js";
import { _resetWalCircuitBreakerForTesting } from "../services/wal-helpers.js";
import { resetPluginRegistrationStateForTests, runtimeRef } from "../setup/register-plugin.js";
import {
  getFullStackConfig,
  invokeHooks,
  makeFullStackApi,
  mergePrependFromHookResults,
  registerFullPlugin,
  type FullStackApi,
} from "./helpers/comprehensive-e2e-harness.js";

vi.mock("../lifecycle/stage-capture.js", () => ({
  runCaptureStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/worker/narratives.js", () => ({
  buildDailyNarrative: vi.fn().mockResolvedValue(undefined),
}));

const HOOK_CTX = {
  sessionKey: "agent:main:telegram:retrieval-eval",
  sessionId: "agent:main:telegram:retrieval-eval",
  agentId: "main",
};

// Pinned floors — just under the MEASURED baseline (fts5, 2026-07: P@5=0.360, R@10=1.000,
// nDCG@10=0.698; P@5 maxes at 0.6 since each query has exactly 3 relevant facts). Raise them when
// the ranking genuinely improves; never lower them to make a regression pass.
const FLOOR_P_AT_5 = 0.3;
const FLOOR_R_AT_10 = 0.95;
const FLOOR_NDCG_AT_10 = 0.65;
const FLOOR_AMBIENT_HIT_RATE = 0.8;

describe("retrieval-eval harness (ranking regression floor)", () => {
  let tmpDir: string;
  let api: FullStackApi;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "retrieval-eval-"));
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

  async function registerEvalStack(): Promise<Map<string, string>> {
    registerFullPlugin(
      api,
      getFullStackConfig(tmpDir, {
        retrieval: { strategies: ["fts5"] },
        graph: { enabled: true, autoLink: false, useInRecall: false, strengthenOnRecall: false },
        autoRecall: {
          enabled: true,
          authFailure: { enabled: false },
          limit: 5,
          maxTokens: 600,
          minScore: 0.01,
          injectionFormat: "full",
        },
        store: { fuzzyDedupe: false, classifyBeforeWrite: false },
      }),
    );
    await runtimeRef.value?.bootstrapAsyncInit?.catch(() => {});

    // Seed straight through FactsDB (fast, FTS stays in sync via the store path).
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
        source: "retrieval-eval",
        tags: [],
      });
      idByFixtureKey.set(fact.fixtureKey, stored.id);
    }
    return idByFixtureKey;
  }

  it("explicit memory_recall stays above the pinned P@5/R@10/nDCG floors", async () => {
    const idByFixtureKey = await registerEvalStack();
    const recall = api.getTool("memory_recall")!;

    const perQuery: Array<{ ranked: string[]; relevant: ReadonlySet<string> }> = [];
    for (const gold of buildGoldQueries()) {
      const res = (await recall.execute("eval", { query: gold.query, limit: 10 })) as {
        details?: { memories?: Array<{ id: string }> };
      };
      perQuery.push({
        ranked: (res.details?.memories ?? []).map((m) => m.id),
        relevant: new Set(gold.relevant.map((key) => idByFixtureKey.get(key)!)),
      });
    }

    const s = summarize(perQuery);
    console.log(
      `[retrieval-eval] explicit fts5 — queries=${s.queries} P@5=${s.meanPrecisionAt5.toFixed(3)} R@10=${s.meanRecallAt10.toFixed(3)} nDCG@10=${s.meanNdcgAt10.toFixed(3)}`,
    );
    expect(s.queries).toBe(30);
    expect(s.meanPrecisionAt5).toBeGreaterThanOrEqual(FLOOR_P_AT_5);
    expect(s.meanRecallAt10).toBeGreaterThanOrEqual(FLOOR_R_AT_10);
    expect(s.meanNdcgAt10).toBeGreaterThanOrEqual(FLOOR_NDCG_AT_10);
  }, 120_000);

  it("auto-recall (ambient injection) surfaces the right topic for a query sample", async () => {
    await registerEvalStack();

    // One token-forward query per even-indexed topic — 5 ambient runs keeps the suite fast.
    const sample = buildGoldQueries().filter((_, i) => i % 6 === 0);
    let hits = 0;
    for (const gold of sample) {
      const results = await invokeHooks(api, "before_agent_start", { prompt: gold.query }, HOOK_CTX);
      const prepend = mergePrependFromHookResults(results);
      const token = gold.query.split(" ")[0];
      if (prepend.includes(token)) hits++;
    }
    const rate = hits / sample.length;
    console.log(`[retrieval-eval] ambient — sample=${sample.length} hitRate=${rate.toFixed(2)}`);
    expect(rate).toBeGreaterThanOrEqual(FLOOR_AMBIENT_HIT_RATE);
  }, 120_000);
});
