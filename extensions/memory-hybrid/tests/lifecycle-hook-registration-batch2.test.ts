/**
 * Lifecycle hook registration beyond agent_end (before_agent_start stages).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { createLifecycleHooks } from "../lifecycle/hooks.js";
import { buildGuardTestLifecycleContext, makeMockHookApi } from "./helpers/lifecycle-hook-harness.js";
import { buildRecallTestConfig } from "./helpers/lifecycle-recall-harness.js";

vi.mock("../lifecycle/stage-capture.js", () => ({
  runCaptureStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/worker/narratives.js", () => ({
  buildDailyNarrative: vi.fn().mockResolvedValue(undefined),
}));

describe("createLifecycleHooks registration (batch 2)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-hook-reg-b2-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers setup and recall before_agent_start when autoRecall is enabled", () => {
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    ctx.cfg = buildRecallTestConfig(tmpDir);
    const api = makeMockHookApi("agent:main:main");

    createLifecycleHooks(ctx).onAgentStart(api as never);

    const events = (api.on as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const beforeStarts = events.filter((e) => e === "before_agent_start");
    expect(beforeStarts.length).toBeGreaterThanOrEqual(2);
  });

  it("registers auth-failure before_agent_start only when authFailure recall is enabled", () => {
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    ctx.cfg = buildRecallTestConfig(tmpDir, {
      autoRecall: {
        enabled: true,
        authFailure: { enabled: true },
      },
    });
    const apiEnabled = makeMockHookApi("agent:main:main");
    createLifecycleHooks(ctx).onAgentStart(apiEnabled as never);
    const enabledCount = (apiEnabled.on as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "before_agent_start",
    ).length;

    const ctxOff = buildGuardTestLifecycleContext(tmpDir, factsDb);
    ctxOff.cfg = buildRecallTestConfig(tmpDir, {
      autoRecall: {
        enabled: true,
        authFailure: { enabled: false },
      },
    });
    const apiOff = makeMockHookApi("agent:main:main");
    createLifecycleHooks(ctxOff).onAgentStart(apiOff as never);
    const offCount = (apiOff.on as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "before_agent_start",
    ).length;

    expect(enabledCount).toBeGreaterThan(offCount);
  });
});
