import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCaptureStage } from "../lifecycle/stage-capture.js";
import type { LifecycleContext, SessionState } from "../lifecycle/types.js";

// ---------------------------------------------------------------------------
// Mock atomicWriteFile so credential auto-detect tests don't touch the FS.
// ---------------------------------------------------------------------------

const atomicWriteFileMock = vi.fn();

vi.mock("../utils/atomic-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/atomic-write.js")>();
  return {
    ...actual,
    atomicWriteFile: (...args: Parameters<typeof actual.atomicWriteFile>) => atomicWriteFileMock(...args),
  };
});

// ---------------------------------------------------------------------------
// Mock detectCredentialPatterns so we can inject patterns without real content.
// ---------------------------------------------------------------------------

const detectCredentialPatternsMock = vi.fn().mockReturnValue([]);

vi.mock("../services/auto-capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/auto-capture.js")>();
  return {
    ...actual,
    detectCredentialPatterns: (...args: Parameters<typeof actual.detectCredentialPatterns>) =>
      detectCredentialPatternsMock(...args),
  };
});

function makeApi(messageChannel?: string) {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    context: {
      sessionId: "session-1",
      agentId: "agent-main",
      messageChannel,
    },
  };
}

function makeContext(overrides?: Partial<LifecycleContext>) {
  const store = vi.fn().mockReturnValue({ id: "fact-1" });
  const context = {
    factsDb: {
      store,
      hasDuplicate: vi.fn().mockReturnValue(false),
    },
    vectorDb: {},
    embeddings: { modelName: "test-model" },
    embeddingRegistry: null,
    openai: null,
    cfg: {
      autoCapture: true,
      captureMaxChars: 5000,
      autoRecall: { enabled: false, summaryThreshold: 0, summaryMaxChars: 200 },
      retrieval: { strategies: [] },
      store: { classifyBeforeWrite: false },
      memoryTiering: { enabled: false, compactionOnSessionEnd: false },
      credentials: { enabled: false },
      humanizer: { enabled: false },
    },
    credentialsDb: null,
    aliasDb: null,
    wal: null,
    eventLog: null,
    narrativesDb: null,
    workflowStore: null,
    currentAgentIdRef: { value: "agent-main" },
    lastProgressiveIndexIds: [],
    restartPendingClearedRef: { value: false },
    resolvedSqlitePath: ":memory:",
    walWrite: vi.fn().mockResolvedValue("wal-1"),
    walRemove: vi.fn().mockResolvedValue(undefined),
    findSimilarByEmbedding: vi.fn().mockResolvedValue([]),
    shouldCapture: vi.fn().mockReturnValue(true),
    detectCategory: vi.fn().mockReturnValue("fact"),
    pendingLLMWarnings: {
      add: vi.fn(),
      drain: vi.fn().mockReturnValue([]),
    },
    issueStore: null,
    recallInFlightRef: { value: 0 },
    ...overrides,
  };

  return { ctx: context as unknown as LifecycleContext, store };
}

function makeSessionState(): SessionState {
  return {
    sessionStartSeen: new Set(),
    ambientSeenFactsMap: new Map(),
    ambientLastEmbeddingMap: new Map(),
    frustrationStateMap: new Map(),
    authFailureRecallsThisSession: new Map(),
    sessionLastActivity: new Map(),
    touchSession: vi.fn(),
    clearSessionState: vi.fn(),
    pruneSessionMaps: vi.fn(),
    resolveSessionKey: vi.fn().mockReturnValue("session-1"),
    MAX_TRACKED_SESSIONS: 100,
  };
}

describe("runCaptureStage", () => {
  beforeEach(() => {
    atomicWriteFileMock.mockReset();
    detectCredentialPatternsMock.mockReturnValue([]);
  });

  it("skips auto-capture for cron/system sessions", async () => {
    const api = makeApi("system");
    const { ctx, store } = makeContext();
    const sessionState = makeSessionState();

    await runCaptureStage(
      {
        success: true,
        prompt: "Nightly memory maintenance. Run in order: openclaw hybrid-mem prune",
        messages: [{ role: "user", content: "Remember this internal cron summary." }],
      },
      api as never,
      ctx,
      sessionState,
    );

    expect(store).not.toHaveBeenCalled();
    expect(ctx.walWrite).not.toHaveBeenCalled();
    expect(api.logger.debug).toHaveBeenCalledWith(expect.stringContaining("skipped conversational auto-capture"));
  });

  it("stores interactive captures with provenance metadata", async () => {
    const api = makeApi("chat");
    const { ctx, store } = makeContext();
    const sessionState = makeSessionState();

    await runCaptureStage(
      {
        success: true,
        messages: [{ role: "user", content: "Remember that I prefer concise answers." }],
      },
      api as never,
      ctx,
      sessionState,
    );

    expect(store).toHaveBeenCalledOnce();
    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({
        provenanceSession: "session-1",
        sourceTurn: 1,
        extractionMethod: "auto-capture:user:interactive",
        extractionConfidence: 1,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Credential auto-detect: atomicity of pendingPath write (Issue #1498).
  // -------------------------------------------------------------------------

  it("writes credential hints atomically via atomicWriteFile when patterns are detected", async () => {
    detectCredentialPatternsMock.mockReturnValue([{ hint: "OPENAI_API_KEY" }, { hint: "GITHUB_TOKEN" }]);

    const api = makeApi("chat");
    const { ctx } = makeContext({
      cfg: {
        autoCapture: false,
        captureMaxChars: 5000,
        autoRecall: { enabled: false, summaryThreshold: 0, summaryMaxChars: 200 },
        retrieval: { strategies: [] },
        store: { classifyBeforeWrite: false },
        memoryTiering: { enabled: false, compactionOnSessionEnd: false },
        credentials: { enabled: true, autoDetect: true },
        humanizer: { enabled: false },
      } as unknown as LifecycleContext["cfg"],
    });
    const sessionState = makeSessionState();

    await runCaptureStage(
      {
        success: true,
        messages: [{ role: "assistant", content: "Here is your key: sk-abc123" }],
      },
      api as never,
      ctx,
      sessionState,
    );

    expect(atomicWriteFileMock).toHaveBeenCalledOnce();
    const [calledPath, calledContent] = atomicWriteFileMock.mock.calls[0] as [string, string];
    expect(calledPath).toMatch(/credentials-pending\.json$/);
    const parsed = JSON.parse(calledContent) as { hints: string[]; at: number };
    expect(parsed.hints).toEqual(["OPENAI_API_KEY", "GITHUB_TOKEN"]);
    expect(typeof parsed.at).toBe("number");
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("credential patterns detected"));
  });

  it("does not call atomicWriteFile when no credential patterns are detected", async () => {
    detectCredentialPatternsMock.mockReturnValue([]);

    const api = makeApi("chat");
    const { ctx } = makeContext({
      cfg: {
        autoCapture: false,
        captureMaxChars: 5000,
        autoRecall: { enabled: false, summaryThreshold: 0, summaryMaxChars: 200 },
        retrieval: { strategies: [] },
        store: { classifyBeforeWrite: false },
        memoryTiering: { enabled: false, compactionOnSessionEnd: false },
        credentials: { enabled: true, autoDetect: true },
        humanizer: { enabled: false },
      } as unknown as LifecycleContext["cfg"],
    });
    const sessionState = makeSessionState();

    await runCaptureStage(
      {
        success: true,
        messages: [{ role: "assistant", content: "No secrets here." }],
      },
      api as never,
      ctx,
      sessionState,
    );

    expect(atomicWriteFileMock).not.toHaveBeenCalled();
  });

  it("catches and logs atomicWriteFile failures without crashing the stage", async () => {
    detectCredentialPatternsMock.mockReturnValue([{ hint: "SECRET_TOKEN" }]);
    atomicWriteFileMock.mockImplementation(() => {
      throw new Error("simulated write failure");
    });

    const api = makeApi("chat");
    const { ctx } = makeContext({
      cfg: {
        autoCapture: false,
        captureMaxChars: 5000,
        autoRecall: { enabled: false, summaryThreshold: 0, summaryMaxChars: 200 },
        retrieval: { strategies: [] },
        store: { classifyBeforeWrite: false },
        memoryTiering: { enabled: false, compactionOnSessionEnd: false },
        credentials: { enabled: true, autoDetect: true },
        humanizer: { enabled: false },
      } as unknown as LifecycleContext["cfg"],
    });
    const sessionState = makeSessionState();

    // Must not throw — error is absorbed by the try/catch in stage-capture.
    await expect(
      runCaptureStage(
        {
          success: true,
          messages: [{ role: "assistant", content: "sk-secret-value" }],
        },
        api as never,
        ctx,
        sessionState,
      ),
    ).resolves.toBeUndefined();

    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("credential auto-detect failed"));
  });
});
