/**
 * registerAuthFailureRecall before_agent_start wiring.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { registerAuthFailureRecall } from "../lifecycle/stage-auth-failure.js";
import { capturePluginError } from "../services/error-reporter.js";
import {
  buildRecallLifecycleContext,
  makeMockStageApi,
  makeRecallSessionState,
} from "./helpers/lifecycle-recall-harness.js";

vi.mock("../services/error-reporter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/error-reporter.js")>();
  return { ...actual, capturePluginError: vi.fn() };
});

describe("registerAuthFailureRecall", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stage-auth-failure-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vi.mocked(capturePluginError).mockClear();
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function captureHandler(ctx: ReturnType<typeof buildRecallLifecycleContext>) {
    const api = makeMockStageApi();
    const sessionState = makeRecallSessionState();
    registerAuthFailureRecall(api as never, ctx, sessionState);
    const reg = (api.on as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "before_agent_start");
    return {
      handler: reg?.[1] as (event: unknown, hookCtx: unknown) => Promise<{ prependContext?: string } | undefined>,
      api,
      sessionState,
    };
  }

  it("skips invalid regex patterns without failing registration", () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      autoRecall: {
        enabled: true,
        authFailure: { enabled: true, patterns: ["[invalid"] },
      },
    });
    const api = makeMockStageApi();
    const sessionState = makeRecallSessionState();

    expect(() => registerAuthFailureRecall(api as never, ctx, sessionState)).not.toThrow();
    expect(capturePluginError).toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalled();
  });

  it("injects credential prependContext when auth failure is detected", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      autoRecall: {
        enabled: true,
        authFailure: { enabled: true, maxRecallsPerTarget: 2, includeVaultHints: true },
      },
    });
    const stored = factsDb.store({
      text: "GitHub API token is ghp_test",
      category: "technical",
      entity: "credentials",
      key: null,
      value: null,
      importance: 0.8,
      tags: ["credential", "github"],
      source: "conversation",
    });
    const entry = factsDb.getById(stored.id)!;
    vi.spyOn(factsDb, "search").mockReturnValue([{ entry, score: 1, backend: "sqlite" }]);
    vi.spyOn(ctx.vectorDb, "search").mockResolvedValue([]);

    const { handler, api } = captureHandler(ctx);
    const out = await handler(
      { prompt: "Permission denied (publickey) when connecting to github.com via ssh" },
      { sessionKey: "agent:main:main", sessionId: "agent:main:main", agentId: "main" },
    );

    expect(out?.prependContext).toBeTruthy();
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("auth failure detected"));
  });
});
