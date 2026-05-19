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
    expect(api.logger.debug).toHaveBeenCalledWith(expect.stringContaining("trace-42"));
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
