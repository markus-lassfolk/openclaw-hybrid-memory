/**
 * agent_end workflow tracking path in hooks.ts (tool_calls → WorkflowTracker.flush).
 * Requires Node >= 22.16 (node:sqlite).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { createLifecycleHooks } from "../lifecycle/hooks.js";
import { buildDailyNarrative } from "../src/worker/narratives.js";
import { buildGuardTestLifecycleContext, makeMockHookApi } from "./helpers/lifecycle-hook-harness.js";

vi.mock("../lifecycle/stage-capture.js", () => ({
  runCaptureStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/worker/narratives.js", () => ({
  buildDailyNarrative: vi.fn().mockResolvedValue(undefined),
}));

describe("lifecycle agent_end workflow tracking", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-agent-workflow-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flushes workflow trace when assistant messages include tool_calls", async () => {
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    ctx.cfg.workflowTracking = { enabled: true, maxTracesPerDay: 100, retentionDays: 90 };
    ctx.cfg.llm = { default: ["openai/gpt-4.1-mini"], heavy: [], nano: ["openai/gpt-4.1-nano"] };
    const narrativeMock = vi.mocked(buildDailyNarrative);
    narrativeMock.mockClear();
    const push = vi.fn();
    const flush = vi.fn().mockReturnValue("trace-42");
    ctx.workflowTracker = { push, flush } as unknown as typeof ctx.workflowTracker;

    const api = makeMockHookApi("agent:main:telegram:wf-1");
    createLifecycleHooks(ctx).onAgentEnd(api as never);
    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "agent_end")?.[1];

    await handler?.(
      {
        messages: [
          { role: "user", content: "deploy the service" },
          {
            role: "assistant",
            tool_calls: [{ function: { name: "bash" } }, { function: { name: "read" } }],
          },
        ],
        success: true,
      },
      { sessionKey: "agent:main:telegram:wf-1", sessionId: "agent:main:telegram:wf-1", agentId: "main" },
    );

    expect(push).toHaveBeenCalledWith("agent:main:telegram:wf-1", "bash", undefined);
    expect(push).toHaveBeenCalledWith("agent:main:telegram:wf-1", "read", undefined);
    expect(flush).toHaveBeenCalledWith("agent:main:telegram:wf-1", "deploy the service", "success");
    expect(narrativeMock).toHaveBeenCalledWith(expect.objectContaining({ model: "openai/gpt-4.1-nano" }));
    expect(api.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("session narrative build failed"));
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("trace-42"));
  });

  it("prefers a user-facing goal over cron/system injections", async () => {
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    ctx.cfg.workflowTracking = { enabled: true, maxTracesPerDay: 100, retentionDays: 90 };
    const flush = vi.fn().mockReturnValue("trace-user-goal");
    ctx.workflowTracker = { push: vi.fn(), flush } as unknown as typeof ctx.workflowTracker;

    const api = makeMockHookApi("agent:main:telegram:wf-2");
    createLifecycleHooks(ctx).onAgentEnd(api as never);
    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "agent_end")?.[1];

    await handler?.(
      {
        messages: [
          { role: "user", content: "[cron:abc] maintenance pulse" },
          { role: "user", content: "Summarize blockers on PR #1043" },
          { role: "assistant", tool_calls: [{ function: { name: "read" } }] },
        ],
        success: true,
      },
      { sessionKey: "agent:main:telegram:wf-2", sessionId: "agent:main:telegram:wf-2", agentId: "main" },
    );

    expect(flush).toHaveBeenCalledWith(
      "agent:main:telegram:wf-2",
      "Summarize blockers on PR #1043",
      "success",
    );
  });

  it("captures tool_use blocks from v3 assistant content", async () => {
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    ctx.cfg.workflowTracking = { enabled: true, maxTracesPerDay: 100, retentionDays: 90 };
    const push = vi.fn();
    const flush = vi.fn().mockReturnValue("trace-v3");
    ctx.workflowTracker = { push, flush, getBuffer: vi.fn().mockReturnValue(["read"]) } as unknown as typeof ctx.workflowTracker;

    const api = makeMockHookApi("agent:main:telegram:wf-3");
    createLifecycleHooks(ctx).onAgentEnd(api as never);
    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "agent_end")?.[1];

    await handler?.(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "Read config and patch" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", name: "read", input: { path: "cfg.json" } }],
          },
        ],
        success: true,
      },
      { sessionKey: "agent:main:telegram:wf-3", sessionId: "agent:main:telegram:wf-3", agentId: "main" },
    );

    expect(push).toHaveBeenCalledWith("agent:main:telegram:wf-3", "read", undefined);
    expect(flush).toHaveBeenCalledWith("agent:main:telegram:wf-3", "Read config and patch", "success");
  });

  it("discards cron-only turns without flushing a workflow trace", async () => {
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    ctx.cfg.workflowTracking = { enabled: true, maxTracesPerDay: 100, retentionDays: 90 };
    const discard = vi.fn();
    const flush = vi.fn();
    ctx.workflowTracker = { push: vi.fn(), flush, discard } as unknown as typeof ctx.workflowTracker;

    const api = makeMockHookApi("agent:main:telegram:wf-cron");
    createLifecycleHooks(ctx).onAgentEnd(api as never);
    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "agent_end")?.[1];

    await handler?.(
      {
        messages: [
          { role: "user", content: "[cron:abc] maintenance pulse" },
          {
            role: "assistant",
            tool_calls: [{ function: { name: "read" } }, { function: { name: "exec" } }],
          },
        ],
        success: true,
      },
      { sessionKey: "agent:main:telegram:wf-cron", sessionId: "agent:main:telegram:wf-cron", agentId: "main" },
    );

    expect(discard).toHaveBeenCalledWith("agent:main:telegram:wf-cron");
    expect(flush).not.toHaveBeenCalled();
    expect(api.logger.debug).toHaveBeenCalledWith(expect.stringContaining("workflow trace skipped"));
  });

  it("does not throw when workflow tracking fails", async () => {
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    ctx.cfg.workflowTracking = { enabled: true, maxTracesPerDay: 100, retentionDays: 90 };
    ctx.workflowTracker = {
      push: vi.fn().mockImplementation(() => {
        throw new Error("tracker push failed");
      }),
      flush: vi.fn(),
    } as unknown as typeof ctx.workflowTracker;

    const api = makeMockHookApi("agent:main:telegram:wf-2");
    createLifecycleHooks(ctx).onAgentEnd(api as never);
    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "agent_end")?.[1];

    await expect(
      handler?.(
        {
          messages: [
            { role: "user", content: "run tools" },
            { role: "assistant", tool_calls: [{ function: { name: "bash" } }] },
          ],
          success: true,
        },
        { sessionKey: "agent:main:telegram:wf-2", sessionId: "agent:main:telegram:wf-2", agentId: "main" },
      ),
    ).resolves.toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("workflow tracking failed"));
  });
});
