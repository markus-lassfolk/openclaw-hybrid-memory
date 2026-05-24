import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { createLifecycleHooks } from "../lifecycle/hooks.js";
import { resetStartupMemoryAttributionForTests } from "../services/startup-memory-attribution.js";
import { buildGuardTestLifecycleContext, makeMockHookApi } from "./helpers/lifecycle-hook-harness.js";

vi.mock("../lifecycle/stage-recall.js", () => ({
  runRecallStage: vi.fn().mockResolvedValue({ kind: "empty", prependContext: undefined }),
}));

describe("lifecycle startup memory checkpoint", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-startup-memory-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    resetStartupMemoryAttributionForTests();
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("logs first recall memory checkpoint once", async () => {
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    ctx.cfg.autoRecall.enabled = true;

    const api = makeMockHookApi("agent:main:startup-memory");
    createLifecycleHooks(ctx).onAgentStart(api as never);
    const beforeAgentStartHandlers = (api.on as ReturnType<typeof vi.fn>).mock.calls
      .filter((args) => args[0] === "before_agent_start")
      .map((args) => args[1])
      .filter((cb): cb is (event: unknown, hookCtx: unknown) => Promise<unknown> => typeof cb === "function");

    const recallHandler = beforeAgentStartHandlers[1];
    expect(recallHandler).toBeTypeOf("function");

    await recallHandler({ prompt: "recall this startup checkpoint" }, { sessionKey: "agent:main:startup-memory" });
    await recallHandler({ prompt: "recall this startup checkpoint again" }, { sessionKey: "agent:main:startup-memory" });

    const startupLogs = api.logger.info.mock.calls
      .reduce<unknown[]>((acc, args) => {
        acc.push(...args);
        return acc;
      }, [])
      .filter((value): value is string => typeof value === "string")
      .filter((msg) => msg.includes("startup-memory-checkpoint") && msg.includes("subsystem=auto-recall"));

    expect(startupLogs).toHaveLength(2);
    expect(startupLogs.some((msg) => msg.includes("phase=startup.first-recall.begin"))).toBe(true);
    expect(startupLogs.some((msg) => msg.includes("phase=startup.first-recall.after"))).toBe(true);
  });
});
