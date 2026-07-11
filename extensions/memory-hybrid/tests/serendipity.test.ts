/**
 * Living-memory B2: the serendipity slot (default ON). Neighbor pool = strong-but-
 * never-recalled graph neighbors of the top results (PRECEDED_BY and weak links excluded);
 * fallback pool = stale-important. Injection is one labeled index-only headline, at most once
 * per cooldownPrompts prompts per session.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { parseAutoRecallConfig } from "../config/parsers/retrieval.js";
import { pickSerendipityFact } from "../services/serendipity.js";
import { _resetWalCircuitBreakerForTesting } from "../services/wal-helpers.js";
import { resetPluginRegistrationStateForTests, runtimeRef } from "../setup/register-plugin.js";
import {
  type FullStackApi,
  getFullStackConfig,
  invokeHooks,
  makeFullStackApi,
  mergePrependFromHookResults,
  registerFullPlugin,
} from "./helpers/comprehensive-e2e-harness.js";

vi.mock("../lifecycle/stage-capture.js", () => ({
  runCaptureStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/worker/narratives.js", () => ({
  buildDailyNarrative: vi.fn().mockResolvedValue(undefined),
}));

const CFG = { minLinkStrength: 0.4, staleImportanceMin: 0.7, staleDays: 30 };

describe("pickSerendipityFact", () => {
  let dir: string;
  let db: FactsDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hybrid-serendipity-"));
    db = new FactsDB(join(dir, "facts.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function storeFact(
    text: string,
    opts?: { importance?: number; recallCount?: number; lastAccessed?: number },
  ): string {
    const id = db.store({
      text,
      entity: null,
      key: null,
      value: null,
      category: "fact",
      importance: opts?.importance ?? 0.5,
      source: "test",
      tags: [],
    } as never).id;
    if (opts?.recallCount !== undefined) {
      db.getRawDb().prepare("UPDATE facts SET recall_count = ? WHERE id = ?").run(opts.recallCount, id);
    }
    if (opts?.lastAccessed !== undefined) {
      db.getRawDb().prepare("UPDATE facts SET last_accessed = ? WHERE id = ?").run(opts.lastAccessed, id);
    }
    return id;
  }

  function seedOf(id: string) {
    const entry = db.getById(id);
    if (!entry) throw new Error("seed fact missing");
    return { factId: id, score: 1, entry };
  }

  it("picks a strong never-recalled neighbor; excludes recalled, weak, PRECEDED_BY, and excluded ids", () => {
    const seed = storeFact("seed fact about deployments");
    const eligible = storeFact("never-recalled strong neighbor");
    const recalled = storeFact("already recalled neighbor", { recallCount: 3 });
    const weak = storeFact("weakly linked neighbor");
    const temporal = storeFact("session-adjacent neighbor");
    const excluded = storeFact("already injected neighbor");
    db.createLink(seed, eligible, "RELATED_TO", 0.8);
    db.createLink(seed, recalled, "RELATED_TO", 0.9);
    db.createLink(seed, weak, "RELATED_TO", 0.2);
    db.createLink(seed, temporal, "PRECEDED_BY", 0.9);
    db.createLink(seed, excluded, "RELATED_TO", 0.9);

    const pick = pickSerendipityFact(db, [seedOf(seed)], CFG, {
      excludeIds: new Set([seed, excluded]),
      random: () => 0,
    });

    expect(pick).toMatchObject({ factId: eligible, reason: "graph-neighbor" });
    expect(pick?.title).toContain("never-recalled strong neighbor");
  });

  it("falls back to stale-important when no neighbor qualifies; null when nothing anywhere", () => {
    const seed = storeFact("isolated seed fact");
    const nowSec = Math.floor(Date.now() / 1000);
    const stale = storeFact("stale but important architectural decision", {
      importance: 0.9,
      lastAccessed: nowSec - 60 * 86_400,
    });

    const pick = pickSerendipityFact(db, [seedOf(seed)], CFG, {
      excludeIds: new Set([seed]),
      nowSec,
      random: () => 0,
    });
    expect(pick).toMatchObject({ factId: stale, reason: "stale-important" });

    const nothing = pickSerendipityFact(db, [seedOf(seed)], CFG, {
      excludeIds: new Set([seed, stale]),
      nowSec,
      random: () => 0,
    });
    expect(nothing).toBeNull();
  });

  it("weighted-random respects the injected random source", () => {
    const seed = storeFact("seed fact for weighting");
    const a = storeFact("neighbor a", { importance: 0.5 });
    const b = storeFact("neighbor b", { importance: 0.5 });
    db.createLink(seed, a, "RELATED_TO", 0.9);
    db.createLink(seed, b, "RELATED_TO", 0.9);

    const low = pickSerendipityFact(db, [seedOf(seed)], CFG, { excludeIds: new Set([seed]), random: () => 0 });
    const high = pickSerendipityFact(db, [seedOf(seed)], CFG, { excludeIds: new Set([seed]), random: () => 0.999 });
    expect(low?.factId).not.toBe(high?.factId); // deterministic ends of the roll pick different items
  });
});

describe("serendipity config parse (default ON)", () => {
  it("defaults on in both parser branches; opt-out and overrides both work", () => {
    expect(parseAutoRecallConfig({}).serendipity).toEqual({
      enabled: true,
      cooldownPrompts: 10,
      minLinkStrength: 0.4,
      staleImportanceMin: 0.7,
      staleDays: 30,
    });
    expect(parseAutoRecallConfig({ autoRecall: { enabled: true } }).serendipity.enabled).toBe(true);
    const off = parseAutoRecallConfig({ autoRecall: { serendipity: { enabled: false } } });
    expect(off.serendipity.enabled).toBe(false);
    const overridden = parseAutoRecallConfig({ autoRecall: { serendipity: { cooldownPrompts: 2 } } });
    expect(overridden.serendipity).toMatchObject({ enabled: true, cooldownPrompts: 2, minLinkStrength: 0.4 });
  });
});

describe("serendipity e2e (label, cooldown, index-only)", () => {
  const HOOK_CTX = {
    sessionKey: "agent:main:telegram:serendipity-e2e",
    sessionId: "agent:main:telegram:serendipity-e2e",
    agentId: "main",
  };
  let tmpDir: string;
  let api: FullStackApi;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "serendipity-e2e-"));
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
    delete process.env.OPENCLAW_HYBRID_MEM_REGISTER_POLICY;
    delete process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY;
  });

  it("fires at the cooldown boundary with the [serendipity] label; exposure is index-only", async () => {
    registerFullPlugin(
      api,
      getFullStackConfig(tmpDir, {
        retrieval: { strategies: ["fts5"] },
        graph: { enabled: true, autoLink: false, strengthenOnRecall: false, useInRecall: false },
        // P3.1 auto-expand would legitimately pull the strong neighbor in as a FULL candidate,
        // which serendipity then rightly excludes — disable it so this test isolates the
        // serendipity path (in production the two mechanisms complement; serendipity covers
        // what expansion doesn't take, else falls back to stale-important).
        graphRetrieval: { autoRecallExpand: { enabled: false } },
        autoRecall: {
          enabled: true,
          limit: 5,
          maxTokens: 600,
          minScore: 0.01,
          injectionFormat: "full",
          serendipity: { enabled: true, cooldownPrompts: 2 },
        },
        store: { fuzzyDedupe: false, classifyBeforeWrite: false },
      }),
    );
    await runtimeRef.value?.bootstrapAsyncInit?.catch(() => {});
    const factsDb = runtimeRef.value!.factsDb;
    const seed = factsDb.store({
      text: "zylophant deployment checklist for the cluster",
      entity: null,
      key: null,
      value: null,
      category: "fact",
      importance: 0.8,
      source: "test",
      tags: [],
    } as never).id;
    const neighbor = factsDb.store({
      text: "quiet architectural memo nobody ever surfaced",
      entity: null,
      key: null,
      value: null,
      category: "fact",
      importance: 0.8,
      source: "test",
      tags: [],
    } as never).id;
    factsDb.createLink(seed, neighbor, "RELATED_TO", 0.9);

    const first = mergePrependFromHookResults(
      await invokeHooks(api, "before_agent_start", { prompt: "zylophant deployment question" }, HOOK_CTX),
    );
    expect(first).not.toContain("[serendipity]");

    const second = mergePrependFromHookResults(
      await invokeHooks(api, "before_agent_start", { prompt: "zylophant deployment again please" }, HOOK_CTX),
    );
    expect(second).toContain("[serendipity]");
    expect(second).toContain("quiet architectural memo");

    const row = factsDb
      .getRawDb()
      .prepare("SELECT recall_count, indexed_count FROM facts WHERE id = ?")
      .get(neighbor) as { recall_count: number | null; indexed_count: number | null };
    expect(row.recall_count ?? 0).toBe(0);
    expect(row.indexed_count ?? 0).toBeGreaterThanOrEqual(1);
  });
});
