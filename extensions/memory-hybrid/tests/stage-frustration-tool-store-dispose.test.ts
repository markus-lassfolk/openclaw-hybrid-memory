/**
 * stage-frustration.ts's module-level ToolEffectivenessStore cache had no dispose path — the
 * plugin's only cleanup hook (stage-cleanup.ts's getDispose()) closed the intent-classifier and
 * memory-nudge caches but never this one, and a config change that alters sqlitePath (e.g.
 * switching vaults) followed by a hot reload replaced the cached instance without closing the
 * old one first. Both leaked the underlying SQLite file handle.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { disposeToolEffectivenessStore, registerFrustrationHandlers } from "../lifecycle/stage-frustration.js";
import { BaseSqliteStore } from "../backends/base-sqlite-store.js";
import {
  buildRecallLifecycleContext,
  makeMockStageApi,
  makeRecallSessionState,
} from "./helpers/lifecycle-recall-harness.js";

describe("stage-frustration ToolEffectivenessStore dispose", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stage-frustration-dispose-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    disposeToolEffectivenessStore();
    vi.restoreAllMocks();
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function captureHandler(ctx: ReturnType<typeof buildRecallLifecycleContext>) {
    const api = makeMockStageApi("agent:main:telegram:frust-dispose");
    const sessionState = makeRecallSessionState();
    registerFrustrationHandlers(api as never, ctx, sessionState);
    const reg = (api.on as Mock).mock.calls.find((c) => c[0] === "before_agent_start");
    return reg?.[1] as (event: unknown, hookCtx: unknown) => Promise<{ prependContext?: string } | undefined>;
  }

  it("closes the cached ToolEffectivenessStore when the plugin dispose hook runs", async () => {
    const closeSpy = vi.spyOn(BaseSqliteStore.prototype, "close");
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      frustrationDetection: { enabled: true, injectionThreshold: 0.3 },
    });
    const handler = captureHandler(ctx);
    // Triggers a real frustration hint, which resolves and caches the tool-effectiveness store.
    await handler(
      { prompt: "This is so frustrating — I already said to use the new API format!" },
      { sessionKey: "agent:main:telegram:frust-dispose", sessionId: "agent:main:telegram:frust-dispose" },
    );

    expect(closeSpy).not.toHaveBeenCalled();
    disposeToolEffectivenessStore();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes the previous instance before opening a new one when sqlitePath changes", async () => {
    const closeSpy = vi.spyOn(BaseSqliteStore.prototype, "close");
    const ctxA = buildRecallLifecycleContext(tmpDir, factsDb, {
      frustrationDetection: { enabled: true, injectionThreshold: 0.3 },
    });
    const handlerA = captureHandler(ctxA);
    await handlerA(
      { prompt: "This is so frustrating — I already said to use the new API format!" },
      { sessionKey: "agent:main:telegram:frust-dispose", sessionId: "agent:main:telegram:frust-dispose" },
    );
    expect(closeSpy).not.toHaveBeenCalled();

    // A second vault/config with a different sqlitePath — resolvedSqlitePath changes, so
    // getToolEffectivenessStore must close the first store before opening the second.
    const tmpDir2 = mkdtempSync(join(tmpdir(), "stage-frustration-dispose-2-"));
    try {
      const factsDb2 = new FactsDB(join(tmpDir2, "facts.db"));
      try {
        const ctxB = buildRecallLifecycleContext(tmpDir2, factsDb2, {
          frustrationDetection: { enabled: true, injectionThreshold: 0.3 },
        });
        const handlerB = captureHandler(ctxB);
        await handlerB(
          { prompt: "This is so frustrating — I already said to use the new API format!" },
          { sessionKey: "agent:main:telegram:frust-dispose-2", sessionId: "agent:main:telegram:frust-dispose-2" },
        );
        expect(closeSpy).toHaveBeenCalledTimes(1);
      } finally {
        factsDb2.close();
      }
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});
