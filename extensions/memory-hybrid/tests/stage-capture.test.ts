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
const classifyMemoryOperationsBatchMock = vi.fn().mockResolvedValue([]);

vi.mock("../services/auto-capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/auto-capture.js")>();
  return {
    ...actual,
    detectCredentialPatterns: (...args: Parameters<typeof actual.detectCredentialPatterns>) =>
      detectCredentialPatternsMock(...args),
  };
});

vi.mock("../services/classification.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/classification.js")>();
  return {
    ...actual,
    classifyMemoryOperationsBatch: (...args: Parameters<typeof actual.classifyMemoryOperationsBatch>) =>
      classifyMemoryOperationsBatchMock(...args),
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
  const storeWithResult = vi.fn().mockImplementation((entry: Parameters<typeof store>[0]) => ({
    entry: store(entry),
    evictedFactId: null,
    skipped: false,
  }));
  const context = {
    factsDb: {
      store,
      storeWithResult,
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
    capabilityHintsSessionsSeen: new Set(),
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
    classifyMemoryOperationsBatchMock.mockReset();
    classifyMemoryOperationsBatchMock.mockResolvedValue([]);
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

  it("skips post-store vector and audit side effects when storeWithResult is skipped", async () => {
    const api = makeApi("chat");
    const storeWithResult = vi.fn().mockReturnValue({
      entry: {
        id: "skipped",
        text: "Remember that I prefer concise answers.",
        category: "fact",
        importance: 0.5,
        source: "auto-capture",
        entity: null,
        key: null,
        value: null,
        createdAt: Math.floor(Date.now() / 1000),
        decayClass: "normal",
        expiresAt: null,
        lastConfirmedAt: 0,
        confidence: 0,
        tags: null,
      },
      evictedFactId: null,
      skipped: true,
    });
    const setEmbeddingModel = vi.fn();
    const vectorStore = vi.fn();
    const vectorHasDuplicate = vi.fn().mockResolvedValue(false);
    const auditAppend = vi.fn();
    const embed = vi.fn().mockResolvedValue([0.01, 0.02, 0.03]);
    const { ctx } = makeContext({
      factsDb: {
        store: vi.fn(),
        storeWithResult,
        hasDuplicate: vi.fn().mockReturnValue(false),
        setEmbeddingModel,
      } as unknown as LifecycleContext["factsDb"],
      vectorDb: {
        store: vectorStore,
        hasDuplicate: vectorHasDuplicate,
      } as unknown as LifecycleContext["vectorDb"],
      embeddings: {
        modelName: "test-model",
        embed,
      } as unknown as LifecycleContext["embeddings"],
      cfg: {
        autoCapture: true,
        captureMaxChars: 5000,
        autoRecall: { enabled: false, summaryThreshold: 0, summaryMaxChars: 200 },
        retrieval: { strategies: ["semantic"] },
        store: { classifyBeforeWrite: false },
        memoryTiering: { enabled: false, compactionOnSessionEnd: false },
        credentials: { enabled: false },
        humanizer: { enabled: false },
      } as unknown as LifecycleContext["cfg"],
      auditStore: {
        append: auditAppend,
      } as unknown as LifecycleContext["auditStore"],
    });
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

    expect(storeWithResult).toHaveBeenCalledOnce();
    expect(setEmbeddingModel).not.toHaveBeenCalled();
    expect(vectorHasDuplicate).not.toHaveBeenCalled();
    expect(vectorStore).not.toHaveBeenCalled();
    expect(auditAppend).not.toHaveBeenCalled();
    expect(ctx.walWrite).toHaveBeenCalledOnce();
    expect(ctx.walRemove).toHaveBeenCalledOnce();
  });

  it("skips update supersession/vector side effects when classified UPDATE store is skipped", async () => {
    const api = makeApi("chat");
    const existingFact = {
      id: "fact-existing",
      text: "Remember to answer concisely.",
      category: "fact",
      importance: 0.8,
      source: "conversation",
      entity: null,
      key: null,
      value: null,
      createdAt: Math.floor(Date.now() / 1000) - 3600,
      decayClass: "normal",
      expiresAt: null,
      lastConfirmedAt: 0,
      confidence: 1,
      tags: null,
      scope: "global",
      scopeTarget: null,
    };
    classifyMemoryOperationsBatchMock.mockResolvedValue([
      { action: "UPDATE", targetId: existingFact.id, reason: "replace old wording" },
    ]);
    const storeWithResult = vi.fn().mockReturnValue({
      entry: { ...existingFact, id: "skipped" },
      evictedFactId: null,
      skipped: true,
    });
    const supersede = vi.fn();
    const aliasDeleteByFactId = vi.fn();
    const vectorDelete = vi.fn().mockResolvedValue(true);
    const auditAppend = vi.fn();
    const { ctx } = makeContext({
      factsDb: {
        store: vi.fn(),
        storeWithResult,
        hasDuplicate: vi.fn().mockReturnValue(false),
        getById: vi.fn((id: string) => (id === existingFact.id ? existingFact : null)),
        findSimilarForClassification: vi.fn().mockReturnValue([existingFact]),
        supersede,
      } as unknown as LifecycleContext["factsDb"],
      aliasDb: {
        deleteByFactId: aliasDeleteByFactId,
      } as unknown as LifecycleContext["aliasDb"],
      vectorDb: {
        delete: vectorDelete,
      } as unknown as LifecycleContext["vectorDb"],
      cfg: {
        autoCapture: true,
        captureMaxChars: 5000,
        autoRecall: { enabled: false, summaryThreshold: 0, summaryMaxChars: 200 },
        retrieval: { strategies: [] },
        store: { classifyBeforeWrite: true },
        memoryTiering: { enabled: false, compactionOnSessionEnd: false },
        credentials: { enabled: false },
        humanizer: { enabled: false },
      } as unknown as LifecycleContext["cfg"],
      auditStore: {
        append: auditAppend,
      } as unknown as LifecycleContext["auditStore"],
    });
    const sessionState = makeSessionState();

    await runCaptureStage(
      {
        success: true,
        messages: [{ role: "user", content: "Remember to answer with one sentence." }],
      },
      api as never,
      ctx,
      sessionState,
    );

    expect(storeWithResult).toHaveBeenCalledOnce();
    expect(supersede).not.toHaveBeenCalled();
    expect(aliasDeleteByFactId).not.toHaveBeenCalled();
    expect(vectorDelete).not.toHaveBeenCalled();
    expect(auditAppend).not.toHaveBeenCalledWith(expect.objectContaining({ action: "auto-capture:updated" }));
    expect(ctx.walWrite).toHaveBeenCalledOnce();
    expect(ctx.walRemove).toHaveBeenCalledOnce();
  });

  it("falls back to ADD storage when a classified UPDATE target is rejected", async () => {
    const api = makeApi("chat");
    const outOfScopeFact = {
      id: "fact-agent",
      text: "Remember to answer concisely.",
      category: "fact",
      importance: 0.8,
      source: "conversation",
      entity: null,
      key: null,
      value: null,
      createdAt: Math.floor(Date.now() / 1000) - 3600,
      decayClass: "normal",
      expiresAt: null,
      lastConfirmedAt: 0,
      confidence: 1,
      tags: null,
      scope: "agent",
      scopeTarget: "agent-other",
    };
    const addedFact = {
      ...outOfScopeFact,
      id: "fact-added",
      text: "Remember to answer with one sentence.",
      scope: "global",
      scopeTarget: null,
    };

    classifyMemoryOperationsBatchMock.mockResolvedValue([
      { action: "UPDATE", targetId: outOfScopeFact.id, reason: "replace old wording" },
    ]);

    const storeWithResult = vi.fn().mockReturnValue({
      entry: addedFact,
      evictedFactId: null,
      skipped: false,
    });
    const supersede = vi.fn();
    const auditAppend = vi.fn();

    const { ctx } = makeContext({
      factsDb: {
        store: vi.fn(),
        storeWithResult,
        hasDuplicate: vi.fn().mockReturnValue(false),
        getById: vi.fn((id: string) => (id === outOfScopeFact.id ? outOfScopeFact : null)),
        findSimilarForClassification: vi.fn().mockReturnValue([outOfScopeFact]),
        supersede,
      } as unknown as LifecycleContext["factsDb"],
      vectorDb: {
        delete: vi.fn().mockResolvedValue(true),
      } as unknown as LifecycleContext["vectorDb"],
      cfg: {
        autoCapture: true,
        captureMaxChars: 5000,
        autoRecall: { enabled: false, summaryThreshold: 0, summaryMaxChars: 200 },
        retrieval: { strategies: [] },
        store: { classifyBeforeWrite: true },
        memoryTiering: { enabled: false, compactionOnSessionEnd: false },
        credentials: { enabled: false },
        humanizer: { enabled: false },
      } as unknown as LifecycleContext["cfg"],
      auditStore: {
        append: auditAppend,
      } as unknown as LifecycleContext["auditStore"],
    });
    const sessionState = makeSessionState();

    await runCaptureStage(
      {
        success: true,
        messages: [{ role: "user", content: "Remember to answer with one sentence." }],
      },
      api as never,
      ctx,
      sessionState,
    );

    expect(api.logger.warn).toHaveBeenCalledWith(
      `memory-hybrid: blocked cross-scope auto-capture UPDATE target ${outOfScopeFact.id}`,
    );
    expect(storeWithResult).toHaveBeenCalledOnce();
    expect(storeWithResult.mock.calls[0]?.[0]).not.toHaveProperty("supersedesId");
    expect(supersede).not.toHaveBeenCalled();
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({ action: "auto-capture:stored" }));
    expect(ctx.walWrite).toHaveBeenCalledOnce();
    expect(ctx.walRemove).toHaveBeenCalledOnce();
  });

  it("persists canonical embedding for classified UPDATE stale merge even when semantic retrieval is disabled", async () => {
    const api = makeApi("chat");
    const existingFact = {
      id: "fact-existing",
      text: "Remember to answer concisely.",
      category: "fact",
      importance: 0.8,
      source: "conversation",
      entity: null,
      key: null,
      value: null,
      createdAt: Math.floor(Date.now() / 1000) - 3600,
      decayClass: "normal",
      expiresAt: null,
      lastConfirmedAt: 0,
      confidence: 1,
      tags: null,
      scope: "global",
      scopeTarget: null,
    };
    const mergedFact = {
      ...existingFact,
      text: "Remember to answer concisely and include rationale.",
    };

    classifyMemoryOperationsBatchMock.mockResolvedValue([
      { action: "UPDATE", targetId: existingFact.id, reason: "replace old wording" },
    ]);

    const storeWithResult = vi.fn().mockReturnValue({
      entry: mergedFact,
      evictedFactId: null,
      skipped: false,
      embeddingStale: true,
    });
    const supersede = vi.fn();
    const setEmbeddingModel = vi.fn();
    const storeEmbedding = vi.fn();
    const vectorStore = vi.fn().mockResolvedValue(mergedFact.id);
    const vectorDelete = vi.fn().mockResolvedValue(true);
    const vectorHasDuplicate = vi.fn().mockResolvedValue(false);
    const embed = vi.fn().mockResolvedValue([0.11, 0.22, 0.33]);

    const { ctx } = makeContext({
      factsDb: {
        store: vi.fn(),
        storeWithResult,
        hasDuplicate: vi.fn().mockReturnValue(false),
        getById: vi.fn((id: string) => (id === existingFact.id ? existingFact : null)),
        findSimilarForClassification: vi.fn().mockReturnValue([existingFact]),
        supersede,
        setEmbeddingModel,
        storeEmbedding,
      } as unknown as LifecycleContext["factsDb"],
      aliasDb: {
        deleteByFactId: vi.fn(),
      } as unknown as LifecycleContext["aliasDb"],
      vectorDb: {
        delete: vectorDelete,
        hasDuplicate: vectorHasDuplicate,
        store: vectorStore,
      } as unknown as LifecycleContext["vectorDb"],
      embeddings: {
        modelName: "test-model",
        embed,
      } as unknown as LifecycleContext["embeddings"],
      cfg: {
        autoCapture: true,
        captureMaxChars: 5000,
        autoRecall: { enabled: false, summaryThreshold: 0, summaryMaxChars: 200 },
        retrieval: { strategies: [] },
        store: { classifyBeforeWrite: true },
        memoryTiering: { enabled: false, compactionOnSessionEnd: false },
        credentials: { enabled: false },
        humanizer: { enabled: false },
      } as unknown as LifecycleContext["cfg"],
    });
    const sessionState = makeSessionState();

    await runCaptureStage(
      {
        success: true,
        messages: [{ role: "user", content: "Remember to answer concisely." }],
      },
      api as never,
      ctx,
      sessionState,
    );

    expect(storeWithResult).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledWith(mergedFact.text);
    expect(setEmbeddingModel).toHaveBeenCalledWith(mergedFact.id, "test-model");
    expect(vectorStore).toHaveBeenCalledWith({
      id: mergedFact.id,
      text: mergedFact.text,
      vector: [0.11, 0.22, 0.33],
      importance: existingFact.importance,
      category: "fact",
    });
    expect(storeEmbedding).toHaveBeenCalledWith(
      mergedFact.id,
      "test-model",
      "canonical",
      new Float32Array([0.11, 0.22, 0.33]),
      3,
    );
    expect(vectorDelete).toHaveBeenCalledWith(existingFact.id);
    expect(supersede).toHaveBeenCalledWith(existingFact.id, mergedFact.id);
    expect(ctx.walWrite).toHaveBeenCalledOnce();
    expect(ctx.walRemove).toHaveBeenCalledOnce();
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

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("credential auto-detect failed: Error: simulated write failure"),
    );
  });

  it("writes vault pointer fact after tool-call credential auto-capture", async () => {
    const token = `ghp_${"A".repeat(36)}`;
    const store = vi.fn().mockReturnValue({ id: "pointer-fact-1", text: "pointer", category: "technical" });
    const storeWithResult = vi.fn().mockImplementation((entry: Parameters<typeof store>[0]) => ({
      entry: store(entry),
      evictedFactId: null,
      skipped: false,
      newlyStored: true,
      embeddingStale: false,
    }));
    const storeIfNew = vi.fn().mockReturnValue(true);
    const credentialsDelete = vi.fn();
    const setEmbeddingModel = vi.fn();
    const vectorStore = vi.fn().mockResolvedValue(undefined);
    const vectorHasDuplicate = vi.fn().mockResolvedValue(false);
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);

    const api = makeApi("chat");
    const { ctx } = makeContext({
      credentialsDb: {
        storeIfNew,
        delete: credentialsDelete,
      } as unknown as LifecycleContext["credentialsDb"],
      factsDb: {
        store,
        storeWithResult,
        hasDuplicate: vi.fn().mockReturnValue(false),
        setEmbeddingModel,
        storeEmbedding: vi.fn(),
      } as unknown as LifecycleContext["factsDb"],
      vectorDb: {
        hasDuplicate: vectorHasDuplicate,
        store: vectorStore,
      } as unknown as LifecycleContext["vectorDb"],
      embeddings: {
        modelName: "test-model",
        embed,
      } as unknown as LifecycleContext["embeddings"],
      cfg: {
        autoCapture: false,
        captureMaxChars: 5000,
        autoRecall: { enabled: false, summaryThreshold: 0, summaryMaxChars: 200 },
        retrieval: { strategies: ["semantic"] },
        store: { classifyBeforeWrite: false },
        memoryTiering: { enabled: false, compactionOnSessionEnd: false },
        credentials: { enabled: true, autoCapture: { toolCalls: true, logCaptures: true } },
        humanizer: { enabled: false },
      } as unknown as LifecycleContext["cfg"],
    });
    const sessionState = makeSessionState();

    await runCaptureStage(
      {
        success: true,
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                function: {
                  name: "exec",
                  arguments: JSON.stringify({
                    command: `export GITHUB_TOKEN=${token}`,
                  }),
                },
              },
            ],
          },
        ],
      },
      api as never,
      ctx,
      sessionState,
    );

    expect(storeIfNew).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "github",
        type: "token",
        value: token,
      }),
    );
    expect(storeWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "Credentials",
        key: "github",
        value: expect.stringMatching(/^vault:/),
      }),
    );
    expect(credentialsDelete).not.toHaveBeenCalled();
    expect(vectorStore).toHaveBeenCalledOnce();
  });

  it("skips tool-call credential capture when vault is unavailable (no plaintext in facts)", async () => {
    const token = `ghp_${"B".repeat(36)}`;
    const storeWithResult = vi.fn();
    const api = makeApi("chat");
    const { ctx } = makeContext({
      credentialsDb: null,
      factsDb: {
        storeWithResult,
      } as unknown as LifecycleContext["factsDb"],
      cfg: {
        autoCapture: false,
        captureMaxChars: 5000,
        autoRecall: { enabled: false, summaryThreshold: 0, summaryMaxChars: 200 },
        retrieval: { strategies: ["semantic"] },
        store: { classifyBeforeWrite: false },
        memoryTiering: { enabled: false, compactionOnSessionEnd: false },
        credentials: { enabled: true, autoCapture: { toolCalls: true, logCaptures: true } },
        humanizer: { enabled: false },
      } as unknown as LifecycleContext["cfg"],
    });
    const sessionState = makeSessionState();

    await runCaptureStage(
      {
        success: true,
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                function: {
                  name: "exec",
                  arguments: JSON.stringify({
                    command: `export GITHUB_TOKEN=${token}`,
                  }),
                },
              },
            ],
          },
        ],
      },
      api as never,
      ctx,
      sessionState,
    );

    expect(storeWithResult).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("vault disabled or unavailable"),
    );
  });
});
