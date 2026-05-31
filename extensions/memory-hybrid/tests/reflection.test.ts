/**
 * Reflection layer — parsePatternsFromReflectionResponse and prompt loading.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { getCurrentCostFeature } from "../services/cost-context.js";
import { runReflection, runReflectionMeta, runReflectionRules } from "../services/reflection.js";
import type { MemoryEntry } from "../types/memory.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";

const { parsePatternsFromReflectionResponse, dotProductSimilarity } = _testing;

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "fact-1",
    text: overrides.text ?? "User prefers TypeScript over JavaScript for type safety",
    category: overrides.category ?? "preference",
    importance: overrides.importance ?? 0.7,
    entity: overrides.entity ?? null,
    key: overrides.key ?? null,
    value: overrides.value ?? null,
    source: overrides.source ?? "test",
    createdAt: overrides.createdAt ?? Date.now(),
    decayClass: overrides.decayClass ?? "stable",
    expiresAt: overrides.expiresAt ?? null,
    lastConfirmedAt: overrides.lastConfirmedAt ?? Date.now(),
    confidence: overrides.confidence ?? 0.7,
    ...overrides,
  };
}

describe("dotProductSimilarity", () => {
  it("returns 1 for identical pre-normalized vectors", () => {
    const v = [1, 0, 0];
    expect(dotProductSimilarity(v, v)).toBe(1);
  });

  it("returns 0 for orthogonal pre-normalized vectors", () => {
    expect(dotProductSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
  });

  it("returns -1 for opposite pre-normalized vectors", () => {
    expect(dotProductSimilarity([1, 0, 0], [-1, 0, 0])).toBe(-1);
  });

  it("returns 0 when lengths differ", () => {
    expect(dotProductSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it("equals cosine similarity for unit vectors", () => {
    const a = [1 / Math.sqrt(2), 1 / Math.sqrt(2)];
    const b = [1 / Math.sqrt(2), -1 / Math.sqrt(2)];
    expect(dotProductSimilarity(a, b)).toBeCloseTo(0, 10);
  });
});

describe("parsePatternsFromReflectionResponse", () => {
  it("extracts valid PATTERN: lines", () => {
    const raw = `
Some intro text.

PATTERN: User consistently favors functional composition over OOP
PATTERN: User prefers small, focused code units (functions <20 lines)
PATTERN: User values type safety (TypeScript strict mode)

Other content ignored.
`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toBe("User consistently favors functional composition over OOP");
    expect(parsed[1]).toBe("User prefers small, focused code units (functions <20 lines)");
    expect(parsed[2]).toBe("User values type safety (TypeScript strict mode)");
  });

  it("ignores lines that are too short (<20 chars)", () => {
    const raw = "PATTERN: Too short";
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(0);
  });

  it("ignores lines that are too long (>500 chars)", () => {
    const long = "x".repeat(501);
    const raw = `PATTERN: ${long}`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(0);
  });

  it("accepts patterns at exact min/max bounds", () => {
    const minLen = "x".repeat(20);
    const maxLen = "x".repeat(500);
    const raw = `PATTERN: ${minLen}\nPATTERN: ${maxLen}`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(2);
  });

  it("deduplicates case-insensitive within batch", () => {
    const raw = `
PATTERN: User prefers composition over inheritance
PATTERN: user prefers composition over inheritance
PATTERN: User prefers composition over inheritance
`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe("User prefers composition over inheritance");
  });

  it("handles leading whitespace before PATTERN:", () => {
    const raw = "  PATTERN: User prefers explicit error handling";
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe("User prefers explicit error handling");
  });

  it("returns empty for empty or non-matching input", () => {
    expect(parsePatternsFromReflectionResponse("")).toHaveLength(0);
    expect(parsePatternsFromReflectionResponse("No PATTERN: here")).toHaveLength(0);
    expect(parsePatternsFromReflectionResponse("RULE: This is a rule")).toHaveLength(0);
  });
});

describe("runReflection cost attribution", () => {
  it("LLM call is attributed to 'reflection' feature", async () => {
    let capturedFeature: string | undefined;
    const fact = makeEntry();
    const factsDb = {
      sqlitePath: join(tmpdir(), "reflect-cost-test.db"),
      getRecentFacts: () => [fact],
      getByCategory: () => [],
      store: async () => ({ id: "pattern-1", text: fact.text, category: "pattern" }) as MemoryEntry,
      setEmbeddingModel: () => undefined,
      getMaintenanceState: () => null,
      setMaintenanceState: () => undefined,
    };
    const vectorDb = {
      store: async () => undefined,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = { embed: async () => [1, 0], modelName: "test-model" };
    const openai = {
      chat: {
        completions: {
          create: async () => {
            capturedFeature = getCurrentCostFeature();
            return { choices: [{ message: { content: "No patterns detected in the provided facts." } }] };
          },
        },
      },
    };

    await runReflection(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { defaultWindow: 14, minObservations: 1, enabled: true },
      { window: 7, dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(capturedFeature).toBe("reflection");
  });
});

describe("runReflectionRules cost attribution", () => {
  it("LLM call is attributed to 'reflection-rules' feature", async () => {
    let capturedFeature: string | undefined;
    const pattern1 = makeEntry({
      id: "p1",
      category: "pattern",
      text: "User consistently prefers functional composition over object-oriented patterns",
    });
    const pattern2 = makeEntry({
      id: "p2",
      category: "pattern",
      text: "User values type safety and always enables TypeScript strict mode in projects",
    });
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? [pattern1, pattern2] : []),
      store: async () => ({ id: "rule-1", text: "Always use functional patterns", category: "rule" }) as MemoryEntry,
      setEmbeddingModel: () => undefined,
    };
    const vectorDb = {
      store: async () => undefined,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = { embed: async () => [1, 0], modelName: "test-model" };
    const openai = {
      chat: {
        completions: {
          create: async () => {
            capturedFeature = getCurrentCostFeature();
            return { choices: [{ message: { content: "No rules detected." } }] };
          },
        },
      },
    };

    await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(capturedFeature).toBe("reflection-rules");
  });
});

describe("runReflectionRules diagnostics", () => {
  const patternEntries = [
    makeEntry({
      id: "p1",
      category: "pattern",
      text: "User consistently prefers functional composition over object-oriented patterns",
    }),
    makeEntry({
      id: "p2",
      category: "pattern",
      text: "User values type safety and always enables TypeScript strict mode in projects",
    }),
  ];

  function makeDeps(responseText: string) {
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? patternEntries : []),
      setEmbeddingModel: () => undefined,
    };
    const vectorDb = {
      store: async () => undefined,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = { embed: async () => [1, 0], modelName: "test-model" };
    const openai = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: responseText } }] }),
        },
      },
    };
    return { factsDb, vectorDb, embeddings, openai };
  }

  it("reports degraded diagnostics for empty model response", async () => {
    const { factsDb, vectorDb, embeddings, openai } = makeDeps("");
    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: true, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(res.diagnostics.status).toBe("degraded");
    expect(res.diagnostics.zeroRulesReason).toBe("empty_model_response");
    expect(res.diagnostics.parseSuccess).toBe(false);
  });

  it("reports degraded diagnostics for invalid response format", async () => {
    const { factsDb, vectorDb, embeddings, openai } = makeDeps("Some prose without RULE lines");
    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: true, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(res.diagnostics.status).toBe("degraded");
    expect(res.diagnostics.zeroRulesReason).toBe("invalid_response_format");
    expect(res.diagnostics.parseSuccess).toBe(false);
  });

  it("reports partial diagnostics when all parsed candidates are duplicates", async () => {
    const existingRule = makeEntry({
      id: "rule-existing",
      category: "rule",
      text: "Always keep strict TypeScript settings enabled across all projects.",
    });
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? patternEntries : cat === "rule" ? [existingRule] : []),
      setEmbeddingModel: () => undefined,
    };
    const vectorDb = {
      store: async () => undefined,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map([[existingRule.id, [1, 0]]]),
    };
    const embeddings = { embed: async () => [1, 0], modelName: "test-model" };
    const openai = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              { message: { content: "RULE: Always keep strict TypeScript settings enabled across all projects." } },
            ],
          }),
        },
      },
    };

    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(res.diagnostics.status).toBe("partial");
    expect(res.diagnostics.zeroRulesReason).toBe("all_candidates_duplicate");
    expect(res.diagnostics.rejectedDuplicates).toBeGreaterThan(0);
  });

  it("treats reused exact-text store results as duplicates without deleting existing facts", async () => {
    const ruleText = "Always keep strict TypeScript settings enabled across all projects.";
    const deleteFact = vi.fn(() => undefined);
    const storeWithResult = vi.fn(() => ({
      skipped: false as const,
      evictedFactId: null,
      embeddingStale: false,
      newlyStored: false,
      preMergeText: null,
      entry: makeEntry({
        id: "rule-existing",
        category: "rule",
        text: ruleText,
      }),
    }));
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? patternEntries : []),
      storeWithResult,
      delete: deleteFact,
      setEmbeddingModel: () => undefined,
    };
    const vectorStore = vi.fn(async () => undefined);
    const vectorDb = {
      store: vectorStore,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = { embed: async () => [1, 0], modelName: "test-model" };
    const openai = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: `RULE: ${ruleText}` } }],
          }),
        },
      },
    };

    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(res.diagnostics.status).toBe("partial");
    expect(res.diagnostics.zeroRulesReason).toBe("all_candidates_duplicate");
    expect(vectorStore).not.toHaveBeenCalled();
    expect(deleteFact).not.toHaveBeenCalled();
  });

  it("preserves skipped duplicate vectors in-run to prevent later near-duplicate inserts", async () => {
    const firstRule = "Always keep strict TypeScript settings enabled across all projects.";
    const secondRule = "Always keep strict TypeScript settings on across every project.";
    const storeWithResult = vi.fn(() => ({
      skipped: false as const,
      evictedFactId: null,
      embeddingStale: false,
      newlyStored: false,
      preMergeText: null,
      entry: makeEntry({
        id: "rule-existing",
        category: "rule",
        text: firstRule,
      }),
    }));
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? patternEntries : []),
      storeWithResult,
      setEmbeddingModel: () => undefined,
    };
    const vectorStore = vi.fn(async () => undefined);
    const vectorDb = {
      store: vectorStore,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = {
      modelName: "test-model",
      embed: vi.fn(async () => [1, 0]),
    };
    const openai = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: `RULE: ${firstRule}\nRULE: ${secondRule}` } }],
          }),
        },
      },
    };

    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(res.diagnostics.zeroRulesReason).toBe("all_candidates_duplicate");
    expect(storeWithResult).toHaveBeenCalledTimes(1);
    expect(vectorStore).not.toHaveBeenCalled();
  });

  it("reports valid no-op zero-rules reason when model explicitly returns no actionable rules", async () => {
    const { factsDb, vectorDb, embeddings, openai } = makeDeps(
      "No actionable rules detected from the supplied patterns.",
    );
    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: true, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(res.diagnostics.status).toBe("ok");
    expect(res.diagnostics.zeroRulesReason).toBe("valid_no_actionable_rules");
    expect(res.diagnostics.parseSuccess).toBe(true);
  });

  it("treats think-wrapped no-op responses as valid_no_actionable_rules", async () => {
    const wrappedNoRules =
      "<think>scratchpad</think>\n<thinking>No actionable rules detected from the supplied patterns.</thinking>";
    const { factsDb, vectorDb, embeddings, openai } = makeDeps(wrappedNoRules);
    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: true, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(res.diagnostics.status).toBe("ok");
    expect(res.diagnostics.zeroRulesReason).toBe("valid_no_actionable_rules");
    expect(res.diagnostics.parseSuccess).toBe(true);
  });

  it("reports partial status when parsed candidates are rejected for length", async () => {
    const { factsDb, vectorDb, embeddings, openai } = makeDeps("RULE: tiny");
    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: true, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(res.diagnostics.zeroRulesReason).toBe("all_candidates_rejected_length");
    expect(res.diagnostics.status).toBe("ok");
  });

  it("counts all parsed RULE lines in parsedCandidates, even if rejected for length", async () => {
    const { factsDb, vectorDb, embeddings, openai } = makeDeps("RULE: tiny\nRULE: short");
    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: true, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(res.diagnostics.parsedCandidates).toBe(2);
    expect(res.diagnostics.rejectedLowConfidence).toBe(0);
    expect(res.diagnostics.parseSuccess).toBe(true);
    expect(res.diagnostics.zeroRulesReason).toBe("all_candidates_rejected_length");
  });

  it("reports degraded status when all candidate embeddings fail", async () => {
    const { factsDb, vectorDb, openai } = makeDeps(
      "RULE: Always keep strict TypeScript settings enabled across all projects.",
    );
    const embeddings = {
      modelName: "test-model",
      embed: async () => {
        throw new Error("embedding unavailable");
      },
    };
    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(res.diagnostics.zeroRulesReason).toBe("all_candidates_embedding_failed");
    expect(res.diagnostics.status).toBe("degraded");
  });

  it("reports metadata-only failures with all_candidates_metadata_failed reason", async () => {
    const ruleText = "Always keep strict TypeScript settings enabled across all projects.";
    const storeWithResult = vi.fn(() => ({
      skipped: false as const,
      evictedFactId: null,
      embeddingStale: false,
      newlyStored: true,
      preMergeText: null,
      entry: makeEntry({
        id: "rule-new",
        category: "rule",
        text: ruleText,
      }),
    }));
    const setEmbeddingModel = vi.fn(() => {
      throw new Error("metadata write failed");
    });
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? patternEntries : []),
      storeWithResult,
      setEmbeddingModel,
      delete: vi.fn(() => undefined),
    };
    const vectorDelete = vi.fn(async () => true);
    const vectorDb = {
      store: vi.fn(async () => undefined),
      delete: vectorDelete,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = { embed: async () => [1, 0], modelName: "test-model" };
    const openai = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: `RULE: ${ruleText}` } }] }),
        },
      },
    };

    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(res.diagnostics.zeroRulesReason).toBe("all_candidates_metadata_failed");
    expect(res.diagnostics.status).toBe("partial");
    expect(vectorDelete).toHaveBeenCalledTimes(1);
  });

  it("rolls back merged rule text when merge re-embed fails", async () => {
    const ruleText = "Always keep strict TypeScript settings enabled across all projects.";
    const existingRuleText = "Always keep strict TypeScript settings enabled for every project.";
    const storeWithResult = vi.fn(() => ({
      skipped: false as const,
      evictedFactId: null,
      embeddingStale: true,
      entry: makeEntry({
        id: "rule-existing",
        category: "rule",
        text: `${existingRuleText}\n${ruleText}`,
      }),
    }));
    const restoreMergedFactText = vi.fn(() => true);
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? patternEntries : []),
      storeWithResult,
      restoreMergedFactText,
      setEmbeddingModel: () => undefined,
    };
    const vectorStore = vi.fn(async () => undefined);
    const vectorDb = {
      store: vectorStore,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = {
      modelName: "test-model",
      embed: vi.fn(async (text: string) => {
        if (text === ruleText) return [1, 0];
        throw new Error("merge embedding failed");
      }),
    };
    const openai = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: `RULE: ${ruleText}` } }] }),
        },
      },
    };

    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(res.diagnostics.zeroRulesReason).toBe("all_candidates_embedding_failed");
    expect(restoreMergedFactText).toHaveBeenCalledTimes(1);
    expect(restoreMergedFactText).toHaveBeenCalledWith("rule-existing", existingRuleText);
    expect(vectorStore).not.toHaveBeenCalled();
  });

  it("uses preMergeText for rollback when merged text cannot be reverse-derived", async () => {
    const ruleText = "Always keep strict TypeScript settings enabled across all projects.";
    const existingRuleText = "Always keep strict TypeScript settings enabled for every project.";
    const storeWithResult = vi.fn(() => ({
      skipped: false as const,
      evictedFactId: null,
      embeddingStale: true,
      newlyStored: false,
      preMergeText: existingRuleText,
      entry: makeEntry({
        id: "rule-existing",
        category: "rule",
        text: `${existingRuleText}\nUNRELATED-MERGE-SUFFIX`,
      }),
    }));
    const restoreMergedFactText = vi.fn(() => true);
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? patternEntries : []),
      storeWithResult,
      restoreMergedFactText,
      setEmbeddingModel: () => undefined,
    };
    const vectorStore = vi.fn(async () => undefined);
    const vectorDb = {
      store: vectorStore,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = {
      modelName: "test-model",
      embed: vi.fn(async (text: string) => {
        if (text === ruleText) return [1, 0];
        throw new Error("merge embedding failed");
      }),
    };
    const openai = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: `RULE: ${ruleText}` } }] }),
        },
      },
    };

    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(restoreMergedFactText).toHaveBeenCalledTimes(1);
    expect(restoreMergedFactText).toHaveBeenCalledWith("rule-existing", existingRuleText);
    expect(vectorStore).not.toHaveBeenCalled();
  });

  it("rolls back merged text without deleting vector when metadata update fails and no pre-merge vector is known", async () => {
    const ruleText = "Always keep strict TypeScript settings enabled across all projects.";
    const existingRuleText = "Always keep strict TypeScript settings enabled for every project.";
    const mergedRuleText = `${existingRuleText}\n${ruleText}`;
    const storeWithResult = vi.fn(() => ({
      skipped: false as const,
      evictedFactId: null,
      embeddingStale: true,
      newlyStored: false,
      preMergeText: existingRuleText,
      entry: makeEntry({
        id: "rule-existing",
        category: "rule",
        text: mergedRuleText,
      }),
    }));
    const restoreMergedFactText = vi.fn(() => true);
    const setEmbeddingModel = vi.fn(() => {
      throw new Error("metadata write failed");
    });
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? patternEntries : []),
      storeWithResult,
      restoreMergedFactText,
      setEmbeddingModel,
    };
    const vectorStore = vi.fn(async () => undefined);
    const vectorDelete = vi.fn(async () => true);
    const vectorDb = {
      store: vectorStore,
      delete: vectorDelete,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = {
      modelName: "test-model",
      embed: vi.fn(async (text: string) => {
        if (text === ruleText) return [1, 0];
        if (text === mergedRuleText) return [0, 1];
        throw new Error(`unexpected embed text: ${text}`);
      }),
    };
    const openai = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: `RULE: ${ruleText}` } }] }),
        },
      },
    };

    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(vectorStore).toHaveBeenCalledTimes(1);
    expect(vectorDelete).not.toHaveBeenCalled();
    expect(restoreMergedFactText).toHaveBeenCalledTimes(1);
  });

  it("restores pre-merge vector after merge metadata rollback when prior vector is known", async () => {
    const ruleText = "Always keep strict TypeScript settings enabled across all projects.";
    const existingRuleText = "Always keep strict TypeScript settings enabled for every project.";
    const mergedRuleText = `${existingRuleText}\n${ruleText}`;
    const existingRule = makeEntry({
      id: "rule-existing",
      category: "rule",
      text: existingRuleText,
      embeddingModel: "test-model",
    });
    const storeWithResult = vi.fn(() => ({
      skipped: false as const,
      evictedFactId: null,
      embeddingStale: true,
      newlyStored: false,
      preMergeText: existingRuleText,
      entry: makeEntry({
        id: "rule-existing",
        category: "rule",
        text: mergedRuleText,
      }),
    }));
    const restoreMergedFactText = vi.fn(() => true);
    let failFirstMetadataWrite = true;
    const setEmbeddingModel = vi.fn(() => {
      if (failFirstMetadataWrite) {
        failFirstMetadataWrite = false;
        throw new Error("metadata write failed");
      }
    });
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? patternEntries : cat === "rule" ? [existingRule] : []),
      storeWithResult,
      restoreMergedFactText,
      setEmbeddingModel,
      deleteEmbeddings: vi.fn(() => undefined),
    };
    const vectorStore = vi.fn(async (_entry: unknown) => undefined);
    const vectorDelete = vi.fn(async () => true);
    const vectorDb = {
      store: vectorStore,
      delete: vectorDelete,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map([[existingRule.id, [1, 0]]]),
    };
    const embeddings = {
      modelName: "test-model",
      embed: vi.fn(async (text: string) => {
        if (text === ruleText) return [0, 1];
        if (text === mergedRuleText) return [0.2, 0.8];
        throw new Error(`unexpected embed text: ${text}`);
      }),
    };
    const openai = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: `RULE: ${ruleText}` } }] }),
        },
      },
    };

    const res = await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.rulesStored).toBe(0);
    expect(res.diagnostics.status).toBe("partial");
    expect(vectorStore).toHaveBeenCalledTimes(2);
    expect((vectorStore.mock.calls[1]?.[0] ?? null) as Record<string, unknown> | null).toMatchObject({
      id: "rule-existing",
      text: existingRuleText,
      category: "rule",
      vector: [1, 0],
    });
    expect(vectorDelete).not.toHaveBeenCalled();
    expect(restoreMergedFactText).toHaveBeenCalledWith("rule-existing", existingRuleText);
    expect(setEmbeddingModel).toHaveBeenCalledTimes(2);
  });
});

describe("reflection merge rollback", () => {
  it("rolls back merged pattern text when merge re-embed fails", async () => {
    const patternText = "User consistently works in small iterative commits with explicit verification checkpoints";
    const existingPatternText = "User prefers incremental delivery with explicit checkpoints";
    const restoreMergedFactText = vi.fn(() => true);
    const factsDb = {
      sqlitePath: join(tmpdir(), "reflect-merge-rollback.db"),
      getRecentFacts: () => [makeEntry({ category: "preference", text: "User likes explicit verification steps" })],
      getByCategory: () => [],
      storeWithResult: vi.fn(() => ({
        skipped: false as const,
        evictedFactId: null,
        embeddingStale: true,
        entry: makeEntry({
          id: "pattern-existing",
          category: "pattern",
          text: `${existingPatternText}\n${patternText}`,
        }),
      })),
      restoreMergedFactText,
      setEmbeddingModel: () => undefined,
      getMaintenanceState: () => null,
      setMaintenanceState: () => undefined,
    };
    const vectorStore = vi.fn(async () => undefined);
    const vectorDb = {
      store: vectorStore,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = {
      modelName: "test-model",
      embed: vi.fn(async (text: string) => {
        if (text === patternText) return [1, 0];
        throw new Error("merge embedding failed");
      }),
    };
    const openai = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: `PATTERN: ${patternText}` } }] }),
        },
      },
    };

    const res = await runReflection(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { defaultWindow: 14, minObservations: 1, enabled: true },
      { window: 7, dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.patternsStored).toBe(0);
    expect(restoreMergedFactText).toHaveBeenCalledWith("pattern-existing", existingPatternText);
    expect(vectorStore).not.toHaveBeenCalled();
  });

  it("rolls back merged meta text when merge re-embed fails", async () => {
    const patternA = makeEntry({ id: "p1", category: "pattern", text: "Pattern one with enough detail to be valid" });
    const patternB = makeEntry({ id: "p2", category: "pattern", text: "Pattern two with enough detail to be valid" });
    const patternC = makeEntry({ id: "p3", category: "pattern", text: "Pattern three with enough detail to be valid" });
    const metaText = "A stable meta-pattern is that the user prefers explicit iterative validation loops";
    const existingMetaText = "The user repeatedly prefers explicit checkpoints in workflows";
    const restoreMergedFactText = vi.fn(() => true);
    const factsDb = {
      getByCategory: () => [patternA, patternB, patternC],
      storeWithResult: vi.fn(() => ({
        skipped: false as const,
        evictedFactId: null,
        embeddingStale: true,
        entry: makeEntry({
          id: "meta-existing",
          category: "pattern",
          text: `${existingMetaText}\n${metaText}`,
          tags: ["reflection", "pattern", "meta"],
        }),
      })),
      restoreMergedFactText,
      setEmbeddingModel: () => undefined,
    };
    const vectorStore = vi.fn(async () => undefined);
    const vectorDb = {
      store: vectorStore,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = {
      modelName: "test-model",
      embed: vi.fn(async (text: string) => {
        if (text === metaText) return [1, 0];
        throw new Error("merge embedding failed");
      }),
    };
    const openai = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: `META: ${metaText}` } }] }),
        },
      },
    };

    const res = await runReflectionMeta(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(res.metaStored).toBe(0);
    expect(restoreMergedFactText).toHaveBeenCalledWith("meta-existing", existingMetaText);
    expect(vectorStore).not.toHaveBeenCalled();
  });
});

describe("runReflectionMeta cost attribution", () => {
  it("LLM call is attributed to 'reflection-meta' feature", async () => {
    let capturedFeature: string | undefined;
    const pattern1 = makeEntry({
      id: "p1",
      category: "pattern",
      text: "User consistently prefers functional composition over object-oriented patterns",
    });
    const pattern2 = makeEntry({
      id: "p2",
      category: "pattern",
      text: "User values type safety and always enables TypeScript strict mode in projects",
    });
    const pattern3 = makeEntry({
      id: "p3",
      category: "pattern",
      text: "User prefers small focused functions under twenty lines with clear single responsibility",
    });
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? [pattern1, pattern2, pattern3] : []),
      store: async () => ({ id: "meta-1", text: "Core meta-pattern", category: "pattern" }) as MemoryEntry,
      setEmbeddingModel: () => undefined,
    };
    const vectorDb = {
      store: async () => undefined,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = { embed: async () => [1, 0], modelName: "test-model" };
    const openai = {
      chat: {
        completions: {
          create: async () => {
            capturedFeature = getCurrentCostFeature();
            return { choices: [{ message: { content: "No meta-patterns detected." } }] };
          },
        },
      },
    };

    await runReflectionMeta(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(capturedFeature).toBe("reflection-meta");
  });
});

describe("Reflection prompt template", () => {
  it("loads reflection prompt with window and facts placeholders", () => {
    const tmpl = loadPrompt("reflection");
    expect(tmpl).toContain("{{window}}");
    expect(tmpl).toContain("{{facts}}");
  });

  it("fillPrompt substitutes window and facts", () => {
    const tmpl = loadPrompt("reflection");
    const filled = fillPrompt(tmpl, { window: "14", facts: "[preference] User likes dark mode" });
    expect(filled).toContain("14");
    expect(filled).toContain("[preference] User likes dark mode");
  });
});
