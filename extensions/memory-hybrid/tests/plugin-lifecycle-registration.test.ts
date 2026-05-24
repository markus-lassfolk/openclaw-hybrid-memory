/**
 * Lifecycle hook registration wiring (real api.on, not registerLifecycleHook mock).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { runCaptureStage } from "../lifecycle/stage-capture.js";
import { registerLifecycleHooks } from "../setup/register-hooks.js";
import { buildGuardTestConfig, buildGuardTestLifecycleContext } from "./helpers/lifecycle-hook-harness.js";

vi.mock("../lifecycle/stage-capture.js", () => ({
  runCaptureStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/worker/narratives.js", () => ({
  buildDailyNarrative: vi.fn().mockResolvedValue(undefined),
}));

describe("registerLifecycleHooks", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-lifecycle-reg-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers agent_end on api.on when hooks are wired", () => {
    const lifecycleCtx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    const cfg = buildGuardTestConfig(tmpDir);

    const api = {
      on: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      context: { sessionId: "e2e-session", agentId: "e2e-agent" },
    };

    const pluginApi = {
      ...lifecycleCtx,
      cfg,
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
      registrationGeneration: 1,
      currentRegistrationGenerationRef: { value: 1 },
    };

    const handle = registerLifecycleHooks(pluginApi as never, api as never);

    const events = (api.on as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toContain("agent_end");
    expect(handle.dispose).toBeTypeOf("function");
  });

  it("stale generation hooks no-op and dispose unsubscribes all handlers", async () => {
    const lifecycleCtx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    const cfg = buildGuardTestConfig(tmpDir);
    const currentRegistrationGenerationRef = { value: 1 };
    const unsubscribers: Array<() => void> = [];
    const api = {
      on: vi.fn((_event: string, _handler: unknown) => {
        const unsubscribe = vi.fn();
        unsubscribers.push(unsubscribe);
        return unsubscribe;
      }),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      context: { sessionId: "e2e-session", sessionKey: "e2e-session", agentId: "e2e-agent" },
    };
    const pluginApi = {
      ...lifecycleCtx,
      cfg,
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
      registrationGeneration: 1,
      currentRegistrationGenerationRef,
    };

    const captureMock = vi.mocked(runCaptureStage);
    captureMock.mockClear();
    const handle = registerLifecycleHooks(pluginApi as never, api as never);
    const agentEndCall = (api.on as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "agent_end");
    expect(agentEndCall?.[1]).toBeTypeOf("function");
    const agentEndHandler = agentEndCall?.[1] as ((event: unknown, hookCtx: unknown) => Promise<unknown>) | undefined;
    expect(agentEndHandler).toBeDefined();

    await agentEndHandler?.(
      { messages: [], success: true, sessionKey: "e2e-session", sessionId: "e2e-session" },
      { sessionKey: "e2e-session", sessionId: "e2e-session", agentId: "e2e-agent" },
    );
    expect(captureMock).toHaveBeenCalledTimes(1);

    currentRegistrationGenerationRef.value = 2;
    await agentEndHandler?.(
      { messages: [], success: true, sessionKey: "e2e-session", sessionId: "e2e-session" },
      { sessionKey: "e2e-session", sessionId: "e2e-session", agentId: "e2e-agent" },
    );
    expect(captureMock).toHaveBeenCalledTimes(1);

    handle.dispose();
    expect(unsubscribers.length).toBeGreaterThan(0);
    for (const unsubscribe of unsubscribers) {
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    }
  });
});
