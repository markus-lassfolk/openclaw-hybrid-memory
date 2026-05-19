/**
 * Minimal MemoryPluginAPI + mock Clawdbot API for registerLifecycleHooks tests.
 */

import { vi } from "vitest";
import type { FactsDB } from "../../backends/facts-db.js";
import type { HybridMemoryConfig } from "../../config.js";
import type { LifecycleContext } from "../../lifecycle/types.js";
import { buildGuardTestConfig, buildGuardTestLifecycleContext } from "./lifecycle-hook-harness.js";

export function makeHooksApi() {
  return {
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "hook-session", sessionKey: "agent:main:main", agentId: "main" },
    resolvePath: vi.fn((p: string) => p),
  };
}

export function buildPluginApiForRegisterHooks(
  tmpDir: string,
  factsDb: FactsDB,
  cfgOverrides: Record<string, unknown> = {},
) {
  const lifecycleCtx = buildGuardTestLifecycleContext(tmpDir, factsDb);
  const cfg = buildGuardTestConfig(tmpDir);
  if (cfgOverrides.autoRecall && typeof cfgOverrides.autoRecall === "object") {
    Object.assign(cfg.autoRecall, cfgOverrides.autoRecall);
    const { autoRecall: _drop, ...rest } = cfgOverrides;
    Object.assign(cfg, rest);
  } else {
    Object.assign(cfg, cfgOverrides);
  }

  return {
    ...lifecycleCtx,
    cfg: cfg as HybridMemoryConfig,
    embeddingRegistry: null,
    credentialsDb: null,
    aliasDb: null,
    wal: null,
    proposalsDb: null,
    eventLog: null,
    narrativesDb: null,
    workflowStore: null,
    issueStore: null,
    crystallizationStore: null,
    toolProposalStore: null,
    verificationStore: null,
    variantQueue: null,
    pythonBridge: null,
    apitapStore: null,
    auditStore: null,
    agentHealthStore: null,
    provenanceService: null,
    timers: { proposalsPruneTimer: { value: null } },
    buildToolScopeFilter: () => undefined,
    runReflection: vi.fn(),
    runReflectionRules: vi.fn(),
    runReflectionMeta: vi.fn(),
    recallInFlightRef: { value: 0 },
    lastAutoRecallPromptRef: { value: null },
  };
}

export function captureHookHandler(
  api: ReturnType<typeof makeHooksApi>,
  eventName: string,
): ((event: unknown, hookCtx?: unknown) => Promise<unknown>) | undefined {
  const reg = (api.on as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === eventName);
  return reg?.[1];
}

export type { LifecycleContext };
