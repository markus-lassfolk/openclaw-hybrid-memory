/**
 * runSetupStage production wiring (session touch, agent detection, event log).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { runSetupStage } from "../lifecycle/stage-setup.js";
import {
  buildRecallLifecycleContext,
  makeMockStageApi,
  makeRecallSessionState,
} from "./helpers/lifecycle-recall-harness.js";

describe("runSetupStage", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-stage-setup-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("touches session from hook context sessionKey", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi("agent:main:telegram:setup-1");
    const touchSpy = vi.spyOn(sessionState, "touchSession");

    await runSetupStage({ prompt: "hello" }, api as never, ctx, sessionState);

    expect(touchSpy).toHaveBeenCalledWith("agent:main:telegram:setup-1");
  });

  it("appends session_start to event log when configured", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    const append = vi.fn();
    ctx.eventLog = { append } as unknown as typeof ctx.eventLog;
    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi("agent:main:telegram:setup-2");

    await runSetupStage({ prompt: "hello" }, api as never, ctx, sessionState);

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent:main:telegram:setup-2",
        eventType: "action_taken",
        content: expect.objectContaining({ action: "session_start" }),
      }),
    );
  });
});
