import { describe, expect, it, vi } from "vitest";
import { runCaptureStage } from "../lifecycle/stage-capture.js";
import type { LifecycleContext, SessionState } from "../lifecycle/types.js";

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
	it("skips auto-capture for cron/system sessions", async () => {
		const api = makeApi("system");
		const { ctx, store } = makeContext();
		const sessionState = makeSessionState();

		await runCaptureStage(
			{
				success: true,
				prompt:
					"Nightly memory maintenance. Run in order: openclaw hybrid-mem prune",
				messages: [
					{ role: "user", content: "Remember this internal cron summary." },
				],
			},
			api as never,
			ctx,
			sessionState,
		);

		expect(store).not.toHaveBeenCalled();
		expect(ctx.walWrite).not.toHaveBeenCalled();
		expect(api.logger.debug).toHaveBeenCalledWith(
			expect.stringContaining("skipped auto-capture"),
		);
	});

	it("stores interactive captures with provenance metadata", async () => {
		const api = makeApi("chat");
		const { ctx, store } = makeContext();
		const sessionState = makeSessionState();

		await runCaptureStage(
			{
				success: true,
				messages: [
					{ role: "user", content: "Remember that I prefer concise answers." },
				],
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
});
