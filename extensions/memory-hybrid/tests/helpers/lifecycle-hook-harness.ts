/**
 * Harness for agent_end lifecycle hook tests (real FactsDB, mocked heavy stages).
 * Requires Node >= 22.16 (node:sqlite).
 */

import { join } from "node:path";
import { vi } from "vitest";
import type { FactsDB } from "../../backends/facts-db.js";
import { hybridConfigSchema, type HybridMemoryConfig } from "../../config.js";
import { createLifecycleHooks } from "../../lifecycle/hooks.js";
import type { LifecycleContext } from "../../lifecycle/types.js";
import { PreFinalizationGuardBlockingError } from "../../services/pre-finalization-guard.js";

export type AgentEndHandler = (event: unknown, hookCtx: unknown) => Promise<void>;

export interface MockHookApi {
  on: ReturnType<typeof vi.fn>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  context: { sessionId: string; sessionKey: string; agentId: string };
}

export function makeMockHookApi(sessionKey: string): MockHookApi {
  return {
    on: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    context: {
      sessionId: sessionKey,
      sessionKey,
      agentId: "main",
    },
  };
}

export function buildGuardTestConfig(tmpDir: string): HybridMemoryConfig {
  return hybridConfigSchema.parse({
    embedding: { apiKey: "sk-test-key-that-is-long-enough", model: "text-embedding-3-small" },
    sqlitePath: join(tmpDir, "facts.db"),
    lanceDbPath: join(tmpDir, "lancedb"),
    verbosity: "normal",
    autoRecall: { enabled: false },
    credentials: { enabled: false, autoDetect: false },
    activeTask: { enabled: false, ledger: "facts" },
    goalStewardship: { enabled: false },
    workflowTracking: { enabled: false },
    frustrationDetection: { enabled: false },
  });
}

export function buildGuardTestLifecycleContext(tmpDir: string, factsDb: FactsDB): LifecycleContext {
  const cfg = buildGuardTestConfig(tmpDir);
  return {
    cfg,
    factsDb,
    edictStore: null as unknown as LifecycleContext["edictStore"],
    vectorDb: { open: vi.fn(), close: vi.fn() } as unknown as LifecycleContext["vectorDb"],
    embeddings: {} as unknown as LifecycleContext["embeddings"],
    embeddingRegistry: null,
    openai: {} as unknown as LifecycleContext["openai"],
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
    findSimilarByEmbedding: vi.fn() as unknown as LifecycleContext["findSimilarByEmbedding"],
    shouldCapture: () => false,
    detectCategory: () => "general" as const,
    pendingLLMWarnings: { drain: () => [] } as unknown as LifecycleContext["pendingLLMWarnings"],
    auditStore: null,
    issueStore: null,
    recallInFlightRef: { value: 0 },
    lastAutoRecallPromptRef: { value: null },
  };
}

export function captureAgentEndHandler(ctx: LifecycleContext): AgentEndHandler {
  const api = makeMockHookApi("unused");
  const hooks = createLifecycleHooks(ctx);
  hooks.onAgentEnd(api as never);
  const registration = (api.on as ReturnType<typeof vi.fn>).mock.calls.find((args) => args[0] === "agent_end");
  if (!registration?.[1]) {
    throw new Error("agent_end handler was not registered");
  }
  return registration[1] as AgentEndHandler;
}

export async function invokeAgentEnd(
  handler: AgentEndHandler,
  api: MockHookApi,
  messages: unknown[],
  sessionKey: string,
): Promise<void> {
  await handler(
    { messages, success: true },
    { sessionKey, sessionId: sessionKey, agentId: "main" },
  );
}

export { PreFinalizationGuardBlockingError };
