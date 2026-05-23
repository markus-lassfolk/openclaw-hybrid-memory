/**
 * Harness for before_agent_start stage tests (recall, injection, setup).
 * Requires Node >= 22.16 (node:sqlite).
 */

import { join } from "node:path";
import { vi } from "vitest";
import type { FactsDB } from "../../backends/facts-db.js";
import { hybridConfigSchema, type HybridMemoryConfig } from "../../config.js";
import { createSessionState } from "../../lifecycle/session-state.js";
import type { LifecycleContext, RecallResult, SessionState } from "../../lifecycle/types.js";
import type { SearchResult } from "../../types/memory.js";

export function buildRecallTestConfig(tmpDir: string, overrides: Record<string, unknown> = {}): HybridMemoryConfig {
  return hybridConfigSchema.parse({
    embedding: { apiKey: "sk-test-key-that-is-long-enough", model: "text-embedding-3-small" },
    sqlitePath: join(tmpDir, "facts.db"),
    lanceDbPath: join(tmpDir, "lancedb"),
    verbosity: "normal",
    autoRecall: {
      enabled: true,
      limit: 5,
      injectionFormat: "full",
      degradationQueueDepth: 1,
      ...((overrides.autoRecall as object) ?? {}),
    },
    credentials: { enabled: false, autoDetect: false },
    activeTask: { enabled: false, ledger: "facts" },
    goalStewardship: { enabled: false },
    workflowTracking: { enabled: false },
    frustrationDetection: { enabled: false },
    graph: { enabled: false },
    procedures: { enabled: false },
    memoryTiering: { enabled: false },
    ...overrides,
  });
}

export function buildRecallLifecycleContext(
  tmpDir: string,
  factsDb: FactsDB,
  configOverrides: Record<string, unknown> = {},
): LifecycleContext {
  const cfg = buildRecallTestConfig(tmpDir, configOverrides);
  return {
    cfg,
    factsDb,
    edictStore: {
      getEdicts: vi.fn().mockReturnValue({ edicts: [], renderForPrompt: "" }),
    } as unknown as LifecycleContext["edictStore"],
    vectorDb: {
      search: vi.fn().mockResolvedValue([]),
      open: vi.fn(),
      close: vi.fn(),
    } as unknown as LifecycleContext["vectorDb"],
    embeddings: {
      modelName: "text-embedding-3-small",
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
    } as unknown as LifecycleContext["embeddings"],
    embeddingRegistry: null,
    openai: {
      chat: { completions: { create: vi.fn() } },
    } as unknown as LifecycleContext["openai"],
    credentialsDb: null,
    aliasDb: null,
    wal: null,
    eventLog: null,
    narrativesDb: null,
    workflowStore: null,
    workflowTracker: undefined,
    currentAgentIdRef: { value: "main" },
    lastProgressiveIndexIds: [],
    restartPendingClearedRef: { value: true },
    resolvedSqlitePath: join(tmpDir, "facts.db"),
    walWrite: vi.fn().mockResolvedValue("wal-id") as unknown as LifecycleContext["walWrite"],
    walRemove: vi.fn().mockResolvedValue(undefined) as unknown as LifecycleContext["walRemove"],
    findSimilarByEmbedding: vi.fn().mockResolvedValue([]) as unknown as LifecycleContext["findSimilarByEmbedding"],
    shouldCapture: () => false,
    detectCategory: () => "general" as const,
    pendingLLMWarnings: { drain: () => [] } as unknown as LifecycleContext["pendingLLMWarnings"],
    auditStore: null,
    issueStore: null,
    recallInFlightRef: { value: 0 },
    lastAutoRecallPromptRef: { value: null },
  };
}

export function makeRecallSessionState(): SessionState {
  return createSessionState();
}

export interface MockStageApi {
  on: ReturnType<typeof vi.fn>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  context: { sessionId: string; sessionKey: string; agentId: string };
}

export function makeMockStageApi(sessionKey = "agent:main:telegram:test"): MockStageApi {
  return {
    on: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    context: { sessionId: sessionKey, sessionKey, agentId: "main" },
  };
}

export function makeMinimalRecallResult(overrides: Partial<RecallResult> = {}): RecallResult {
  const candidate: SearchResult = {
    entry: {
      id: "fact-1",
      text: "User prefers concise answers.",
      category: "preference",
      entity: null,
      key: null,
      value: null,
      summary: null,
      tags: [],
      importance: 0.5,
      decayClass: "stable",
      recallCount: 0,
      lastConfirmedAt: 0,
      confidence: 1,
      source: "conversation",
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: null,
      validFrom: 0,
      validUntil: null,
      supersededBy: null,
      scope: "global",
    },
    score: 0.9,
    backend: "sqlite",
  };
  return {
    candidates: [candidate],
    issueBlock: "",
    narrativeBlock: "",
    hotBlock: "",
    procedureBlock: "",
    withProcedures: (s: string) => s,
    recallSpan: "test-span",
    recallStartMs: Date.now() - 100,
    degradationMaxLatencyMs: 0,
    injectionFormat: "full",
    maxTokens: 2000,
    maxPerMemoryChars: 0,
    useSummaryInInjection: false,
    indexCap: 2000,
    summarizeWhenOverBudget: false,
    summarizeModel: undefined,
    groupByCategory: false,
    pinnedRecallThreshold: 3,
    lastProgressiveIndexIdsRef: [],
    ambientCfg: { enabled: false },
    ambientSeenFacts: null,
    ...overrides,
  };
}
