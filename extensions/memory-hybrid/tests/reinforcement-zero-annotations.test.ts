/**
 * Tests for issue #1639: extract-reinforcement reports success after 32 incidents but 0 annotations.
 *
 * Covers:
 * - Successful annotation (incidents with recalledMemoryIds)
 * - No-match benign: all incidents have no recalled memory IDs → annotationStatus = "partial_no_matches"
 * - No-match unexpected: incidents had recalled IDs but annotation errored → "failed_annotation"
 * - LLM timeout/failure → annotationStatus = "degraded_model_or_parser"
 * - Fallback chain is derived from resolveReflectionModelAndFallbacks, not empty when configured
 * - Maintenance validation semantics: annotated count and reason breakdown are reported
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { runExtractReinforcementForCli } from "../cli/handlers.js";
import type { HandlerContext } from "../cli/handlers.js";
import { clearScanLock } from "../cli/shared.js";
import * as adaptiveLlm from "../services/adaptive-maintenance-llm.js";

vi.mock("../services/vector-search.js", () => ({
  findSimilarByEmbedding: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let factsDb: FactsDB;
let proposalsDb: ProposalsDB;

function makeOpenAIMock(responseText: string) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: responseText } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      },
    },
  } as any;
}

function makeOpenAIErrorMock(error: Error) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockRejectedValue(error),
      },
    },
  } as any;
}

function makeCtx(openai: any, extra: Partial<HandlerContext> = {}): HandlerContext {
  return {
    factsDb,
    vectorDb: {
      hasDuplicate: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
    } as any,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
      modelName: "test-model",
    } as any,
    openai,
    proposalsDb,
    cfg: {
      procedures: { sessionsDir: tmpDir },
      distill: {},
      reinforcement: {
        enabled: true,
        passiveBoost: 0.1,
        activeBoost: 0.05,
        maxConfidence: 1.0,
        similarityThreshold: 0.85,
        trackContext: true,
        maxEventsPerFact: 50,
        diversityWeight: 1.0,
        boostAmount: 1.0,
      },
      selfCorrection: {
        semanticDedup: false,
        semanticDedupThreshold: 0.92,
        toolsSection: "Self-correction rules",
        applyToolsByDefault: true,
        autoRewriteTools: false,
        analyzeViaSpawn: false,
        spawnThreshold: 15,
        spawnModel: "",
        positiveRulesSection: "Positive Reinforcement Rules",
        reinforcementLLMAnalysis: true,
        reinforcementToProposals: true,
        agentsRuleToProposals: true,
      },
      llm: {
        default: ["test-model"],
        heavy: ["test-model"],
        maintenance: ["test-model"],
        _source: undefined,
      },
      store: { classifyBeforeWrite: false },
      autoRecall: { enabled: false },
    } as any,
    credentialsDb: null,
    aliasDb: null,
    wal: null,
    identityReflectionStore: null,
    personaStateStore: null,
    resolvedSqlitePath: join(tmpDir, "facts.db"),
    resolvedLancePath: join(tmpDir, "lance"),
    pluginId: "test",
    logger: { info: vi.fn(), warn: vi.fn() },
    detectCategory: () => "technical",
    ...extra,
  };
}

/** Write a session JSONL where agent response contains a recalled memory ID tool result. */
function writeSessionWithMemoryRecall(path: string, memoryId: string): void {
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "memory_recall", id: "tool1" },
            { type: "tool_result", tool_use_id: "tool1", content: `Found memory: ${memoryId}` },
            { type: "text", text: "Based on what I know: here is a detailed fix with 10 steps." },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Perfect! Exactly what I needed." }],
        },
      }),
    ].join("\n"),
    "utf-8",
  );
}

/** Write a session JSONL where agent response does NOT contain any memory recall (no IDs). */
function writeSessionWithoutMemoryRecall(path: string): void {
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I implemented the fix you requested. Here is the complete solution with all edge cases covered.",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Brilliant! Exactly how I wanted this done." }],
        },
      }),
    ].join("\n"),
    "utf-8",
  );
}

/** Write a session where memory_recall is called but tool_result has no parseable UUID IDs. */
function writeSessionWithMemoryRecallButNoIds(path: string): void {
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "memory_recall", id: "tool1" },
            { type: "tool_result", tool_use_id: "tool1", content: "No matching memories found for this query." },
            {
              type: "text",
              text: "I used recall but found no relevant memory IDs, so I derived a complete fix with clear implementation steps.",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Perfect! Exactly what I needed." }],
        },
      }),
    ].join("\n"),
    "utf-8",
  );
}

/**
 * Write a session JSONL with no memory recall IDs, but with a tool call sequence
 * so procedure reinforcement runs.
 */
function writeSessionWithoutMemoryRecallWithTools(path: string): void {
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "read_file", id: "tool1" },
            { type: "tool_use", name: "edit_file", id: "tool2" },
            { type: "text", text: "Applied the requested update and verified the behavior." },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Perfect! Exactly what I needed." }],
        },
      }),
    ].join("\n"),
    "utf-8",
  );
}

/**
 * Store a fact in factsDb and return the generated ID.
 * FactsDB.store() omits `id` from StoreFactInput; IDs are always generated internally.
 */
function storeFactGetId(db: FactsDB, text: string, extra?: { category?: string; importance?: number }): string {
  const entry = db.store({
    text,
    category: extra?.category ?? "technical",
    importance: extra?.importance ?? 0.7,
    source: "test",
    entity: null,
    key: null,
    value: null,
    tags: [],
  });
  return entry.id;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "reinf-zero-ann-test-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
  vi.spyOn(adaptiveLlm, "chatCompleteWithAdaptiveMaintenanceRetry").mockResolvedValue({
    content: "[]",
  } as Awaited<ReturnType<typeof adaptiveLlm.chatCompleteWithAdaptiveMaintenanceRetry>>);
  // Block standalone praise-signal writes (#1802) so #1639 zero-annotation semantics remain testable.
  vi.spyOn(factsDb, "hasDuplicate").mockReturnValue(true);
});

afterEach(() => {
  clearScanLock("extract-reinforcement");
  vi.restoreAllMocks();
  factsDb.close();
  proposalsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Successful annotation path
// ---------------------------------------------------------------------------

describe("successful annotation (#1639)", () => {
  it("annotated count is > 0 and annotationStatus is undefined when facts are reinforced", async () => {
    // Store the fact first to get the real generated ID, then write session with that ID
    const realId = storeFactGetId(factsDb, "Use proactive CI checks before merging");

    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeSessionWithMemoryRecall(sessionFile, realId);

    const openai = makeOpenAIMock("[]");
    const ctx = makeCtx(openai);
    const result = await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    expect(result.incidents.length).toBeGreaterThan(0);
    expect(result.annotated).toBeGreaterThan(0);
    expect(result.annotationStatus).toBeUndefined();
    expect(result.annotationReasons?.reinforced).toBeGreaterThan(0);
    expect(result.annotationReasons?.noRecalledIds).toBe(0);
    expect(result.annotationReasons?.recalledIdsNoMatch).toBe(0);
    expect(result.annotationReasons?.errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No-match benign: all incidents have no recalled IDs
// ---------------------------------------------------------------------------

describe("no-match benign (partial_no_matches) (#1639)", () => {
  it("annotationStatus is partial_no_matches when all incidents have no recalled memory IDs", async () => {
    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeSessionWithoutMemoryRecall(sessionFile);

    const openai = makeOpenAIMock("[]");
    const ctx = makeCtx(openai);
    const result = await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    expect(result.incidents.length).toBeGreaterThan(0);
    expect(result.annotated).toBe(0);
    expect(result.annotationStatus).toBe("partial_no_matches");
    expect(result.annotationDiagnostic?.kind).toBe("expected_sparse_data");
    expect(result.annotationReasons?.noRecalledIds).toBe(result.incidents.length);
    expect(result.annotationReasons?.reinforced).toBe(0);
    expect(result.annotationReasons?.recalledIdsNoMatch).toBe(0);
    expect(result.annotationReasons?.errors).toBe(0);
  });

  it("annotationReasons counts are correct for multiple sessions without memory recall", async () => {
    for (let i = 1; i <= 3; i++) {
      writeSessionWithoutMemoryRecall(join(tmpDir, `2026-01-0${i}-session.jsonl`));
    }

    const openai = makeOpenAIMock("[]");
    const ctx = makeCtx(openai);
    const result = await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    expect(result.incidents.length).toBeGreaterThan(0);
    expect(result.annotated).toBe(0);
    expect(result.annotationStatus).toBe("partial_no_matches");
    expect(result.annotationDiagnostic?.kind).toBe("expected_sparse_data");
    // All incidents should be counted as noRecalledIds
    expect(result.annotationReasons?.noRecalledIds).toBe(result.incidents.length);
  });

  it("classifies partial_no_matches as missing_recall_metadata when memory_recall ran but IDs were absent", async () => {
    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeSessionWithMemoryRecallButNoIds(sessionFile);

    const openai = makeOpenAIMock("[]");
    const ctx = makeCtx(openai);
    const result = await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    expect(result.annotationStatus).toBe("partial_no_matches");
    expect(result.annotationDiagnostic?.kind).toBe("missing_recall_metadata");
    expect(result.annotationDiagnostic?.summary).toContain("memory_recall");
  });
});

// ---------------------------------------------------------------------------
// LLM analysis failed → degraded_model_or_parser
// ---------------------------------------------------------------------------

describe("LLM failure → degraded_model_or_parser (#1639)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("annotationStatus is degraded_model_or_parser when LLM throws and all incidents have no recalled IDs", async () => {
    vi.spyOn(adaptiveLlm, "chatCompleteWithAdaptiveMaintenanceRetry").mockRejectedValue(
      new Error("LLM provider unavailable"),
    );
    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeSessionWithoutMemoryRecall(sessionFile);

    const openai = makeOpenAIErrorMock(new Error("Connection timeout"));
    const ctx = makeCtx(openai);
    const result = await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    expect(result.incidents.length).toBeGreaterThan(0);
    expect(result.annotated).toBe(0);
    // LLM failure + no recalled IDs = degraded_model_or_parser
    expect(result.annotationStatus).toBe("degraded_model_or_parser");
  });

  it("annotationStatus is degraded_model_or_parser when LLM returns unparseable output", async () => {
    vi.spyOn(adaptiveLlm, "chatCompleteWithAdaptiveMaintenanceRetry").mockResolvedValue({
      content: "No JSON available.",
    } as Awaited<ReturnType<typeof adaptiveLlm.chatCompleteWithAdaptiveMaintenanceRetry>>);
    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeSessionWithoutMemoryRecall(sessionFile);

    const openai = makeOpenAIMock("No JSON available.");
    const ctx = makeCtx(openai);
    const result = await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    expect(result.incidents.length).toBeGreaterThan(0);
    expect(result.annotated).toBe(0);
    expect(result.annotationStatus).toBe("degraded_model_or_parser");
    expect(result.annotationReasons?.noRecalledIds).toBe(result.incidents.length);
  });

  it("annotationStatus is degraded_model_or_parser when native tool_calls payload is unparseable", async () => {
    vi.spyOn(adaptiveLlm, "chatCompleteWithAdaptiveMaintenanceRetry").mockResolvedValue({
      content: "",
      toolCalls: [{ name: "annotate", arguments: "not json" }],
    } as Awaited<ReturnType<typeof adaptiveLlm.chatCompleteWithAdaptiveMaintenanceRetry>>);
    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeSessionWithoutMemoryRecall(sessionFile);

    const openai = makeOpenAIMock("[]");
    const ctx = makeCtx(openai);
    const result = await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    expect(result.annotationStatus).toBe("degraded_model_or_parser");
  });
});

describe("procedure boost errors are surfaced (#1639)", () => {
  it("counts no-recall procedure boost failures as annotation errors", async () => {
    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeSessionWithoutMemoryRecallWithTools(sessionFile);
    vi.spyOn(factsDb, "searchProcedures").mockImplementation(() => {
      throw new Error("procedure lookup failed");
    });

    const openai = makeOpenAIMock("[]");
    const ctx = makeCtx(openai);
    const result = await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    expect(result.incidents.length).toBeGreaterThan(0);
    expect(result.annotated).toBe(0);
    expect(result.annotationStatus).toBe("failed_annotation");
    expect(result.annotationReasons?.noRecalledIds).toBe(result.incidents.length);
    expect(result.annotationReasons?.errors).toBe(result.incidents.length);
  });
});

// ---------------------------------------------------------------------------
// Fallback chain is non-empty when configured
// ---------------------------------------------------------------------------

describe("fallback chain derived from configured llm tier (#1639)", () => {
  it("fallback chain is non-empty when llm.maintenance has multiple models configured", async () => {
    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeSessionWithoutMemoryRecall(sessionFile);

    const openai = makeOpenAIMock("[]");
    const ctx = makeCtx(openai, {
      cfg: {
        procedures: { sessionsDir: tmpDir },
        distill: { extractionModelTier: "maintenance" },
        reinforcement: {
          enabled: true,
          trackContext: true,
          maxEventsPerFact: 50,
          diversityWeight: 1.0,
          boostAmount: 1.0,
        },
        selfCorrection: {
          semanticDedup: false,
          reinforcementLLMAnalysis: true,
          reinforcementToProposals: false,
        },
        llm: {
          maintenance: ["minimax/MiniMax-M2.7-highspeed", "google/gemini-2.0-flash"],
          default: ["minimax/MiniMax-M2.7-highspeed"],
          _source: undefined,
        },
        store: { classifyBeforeWrite: false },
        autoRecall: { enabled: false },
      } as any,
    });

    // Capture logger output to verify fallback chain log
    const logMessages: string[] = [];
    ctx.logger = { info: vi.fn((msg: string) => logMessages.push(msg)), warn: vi.fn() };

    await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    // Find the fallback chain log message
    const fallbackLog = logMessages.find((m) => m.includes("fallback chain"));
    expect(fallbackLog).toBeDefined();
    // With two models in maintenance, fallback chain should contain the second model
    expect(fallbackLog).toContain("google/gemini-2.0-flash");
  });

  it("fallback chain picks up llm.fallbackModel when llm.maintenance has only one entry", async () => {
    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeSessionWithoutMemoryRecall(sessionFile);

    const openai = makeOpenAIMock("[]");
    const ctx = makeCtx(openai, {
      cfg: {
        procedures: { sessionsDir: tmpDir },
        distill: { extractionModelTier: "maintenance" },
        reinforcement: {
          enabled: true,
          trackContext: true,
          maxEventsPerFact: 50,
          diversityWeight: 1.0,
          boostAmount: 1.0,
        },
        selfCorrection: {
          semanticDedup: false,
          reinforcementLLMAnalysis: true,
          reinforcementToProposals: false,
        },
        llm: {
          maintenance: ["minimax/MiniMax-M2.7-highspeed"],
          default: ["minimax/MiniMax-M2.7-highspeed"],
          fallbackModel: "google/gemini-2.0-flash",
          _source: undefined,
        },
        store: { classifyBeforeWrite: false },
        autoRecall: { enabled: false },
      } as any,
    });

    const logMessages: string[] = [];
    ctx.logger = { info: vi.fn((msg: string) => logMessages.push(msg)), warn: vi.fn() };

    await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    const fallbackLog = logMessages.find((m) => m.includes("fallback chain"));
    expect(fallbackLog).toBeDefined();
    // llm.fallbackModel should appear in the chain even when maintenance only has one model
    expect(fallbackLog).toContain("google/gemini-2.0-flash");
  });
});

// ---------------------------------------------------------------------------
// Maintenance validation semantics
// ---------------------------------------------------------------------------

describe("maintenance validation semantics (#1639)", () => {
  it("annotated field reflects actual reinforced facts, not just recalledMemoryIds count", async () => {
    // Store fact first, get real ID, then write session with that ID
    const realId = storeFactGetId(factsDb, "Always break tasks into milestones", {
      category: "behavioral",
      importance: 0.8,
    });

    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeSessionWithMemoryRecall(sessionFile, realId);

    const openai = makeOpenAIMock("[]");
    const ctx = makeCtx(openai);
    const result = await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    // annotated should match actual reinforced facts
    expect(typeof result.annotated).toBe("number");
    expect(result.annotated).toBeGreaterThan(0);
    expect(result.annotationReasons).toBeDefined();
    expect(result.annotationReasons?.reinforced).toBeGreaterThan(0);
    expect(result.annotationReasons?.recalledIdsNoMatch).toBe(0);
  });

  it("sets failed_annotation and recalledIdsNoMatch when recalled IDs do not map to reinforceable facts", async () => {
    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeSessionWithMemoryRecall(sessionFile, "bbbbbbbb-0000-0000-0000-000000000002");

    const openai = makeOpenAIMock("[]");
    const ctx = makeCtx(openai);
    const result = await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    expect(result.incidents.length).toBeGreaterThan(0);
    expect(result.annotated).toBe(0);
    expect(result.annotationStatus).toBe("failed_annotation");
    expect(result.annotationDiagnostic?.kind).toBe("stale_recalled_ids");
    expect(result.annotationReasons?.noRecalledIds).toBe(0);
    expect(result.annotationReasons?.reinforced).toBe(0);
    expect(result.annotationReasons?.recalledIdsNoMatch).toBe(result.incidents.length);
    expect(result.annotationReasons?.errors).toBe(0);
  });

  it("dry-run leaves annotated at 0 and annotationStatus unset", async () => {
    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    // Write a session with some non-existent ID (dry-run won't annotate regardless)
    writeSessionWithMemoryRecall(sessionFile, "bbbbbbbb-0000-0000-0000-000000000002");

    const openai = makeOpenAIMock("[]");
    const ctx = makeCtx(openai);
    const result = await runExtractReinforcementForCli(ctx, { workspace: tmpDir, dryRun: true });

    // Dry-run should not annotate
    expect(result.annotated).toBe(0);
    expect(result.annotationStatus).toBeUndefined();
    // annotationReasons should reflect the un-run annotation pass (all zeros)
    expect(result.annotationReasons?.noRecalledIds).toBe(0);
    expect(result.annotationReasons?.reinforced).toBe(0);
    expect(result.annotationReasons?.recalledIdsNoMatch).toBe(0);
    expect(result.annotationReasons?.errors).toBe(0);
  });

  it("skipped result returns no annotation fields set meaningfully", async () => {
    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeSessionWithoutMemoryRecall(sessionFile);

    const openai = makeOpenAIMock("[]");
    const ctx = makeCtx(openai);

    // First run sets the cursor watermark
    await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    // Second run within 23h should be skipped
    const result2 = await runExtractReinforcementForCli(ctx, { workspace: tmpDir });
    expect((result2 as any).skipped).toBe(true);
  });

  it("annotationStatus is undefined when no incidents found", async () => {
    // Empty session — no reinforcement signals
    writeFileSync(join(tmpDir, "2026-01-01-empty.jsonl"), "", "utf-8");

    const openai = makeOpenAIMock("[]");
    const ctx = makeCtx(openai);
    const result = await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    expect(result.incidents.length).toBe(0);
    expect(result.annotationStatus).toBeUndefined();
  });
});
