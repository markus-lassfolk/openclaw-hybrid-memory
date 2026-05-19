/**
 * registerFrustrationHandlers before_agent_start wiring (#263).
 * Requires Node >= 22.16 (node:sqlite).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { registerFrustrationHandlers } from "../lifecycle/stage-frustration.js";
import {
  buildRecallLifecycleContext,
  makeMockStageApi,
  makeRecallSessionState,
} from "./helpers/lifecycle-recall-harness.js";

describe("registerFrustrationHandlers", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stage-frustration-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function captureHandler(ctx: ReturnType<typeof buildRecallLifecycleContext>) {
    const api = makeMockStageApi("agent:main:telegram:frust");
    const sessionState = makeRecallSessionState();
    registerFrustrationHandlers(api as never, ctx, sessionState);
    const reg = (api.on as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "before_agent_start");
    return {
      handler: reg?.[1] as (event: unknown, hookCtx: unknown) => Promise<{ prependContext?: string } | undefined>,
      api,
      sessionState,
    };
  }

  it("skips detection when user content is shorter than 5 characters", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      frustrationDetection: { enabled: true, injectionThreshold: 0.3 },
    });
    const { handler } = captureHandler(ctx);
    const out = await handler(
      { prompt: "ok" },
      { sessionKey: "agent:main:telegram:frust", sessionId: "agent:main:telegram:frust" },
    );
    expect(out).toBeUndefined();
  });

  it("injects frustration-signal prependContext on explicit frustration language", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      frustrationDetection: { enabled: true, injectionThreshold: 0.3, feedToImplicitPipeline: true },
    });
    const { handler } = captureHandler(ctx);
    const out = await handler(
      { prompt: "This is so frustrating — I already said to use the new API format!" },
      { sessionKey: "agent:main:telegram:frust", sessionId: "agent:main:telegram:frust" },
    );
    expect(out?.prependContext).toContain("<frustration-signal>");
  });

  it("does not inject prependContext when verbosity is silent", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      verbosity: "silent",
      frustrationDetection: { enabled: true, injectionThreshold: 0.1 },
    });
    const { handler } = captureHandler(ctx);
    const out = await handler(
      { prompt: "This is incredibly frustrating and broken again" },
      { sessionKey: "agent:main:telegram:frust", sessionId: "agent:main:telegram:frust" },
    );
    expect(out).toBeUndefined();
  });

  it("exports implicit signals to SQLite without throwing", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      frustrationDetection: { enabled: true, injectionThreshold: 0.3, feedToImplicitPipeline: true },
    });
    const { handler } = captureHandler(ctx);
    await expect(
      handler(
        { prompt: "Ugh, not again — stop ignoring my instructions" },
        { sessionKey: "agent:main:telegram:frust", sessionId: "agent:main:telegram:frust" },
      ),
    ).resolves.not.toThrow();

    const row = factsDb
      .getRawDb()
      .prepare("SELECT COUNT(*) as cnt FROM implicit_signals WHERE session_file = ?")
      .get("agent:main:telegram:frust") as { cnt: number };
    expect(row.cnt).toBeGreaterThan(0);
  });
});
