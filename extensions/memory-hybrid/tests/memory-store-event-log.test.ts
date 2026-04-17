// @ts-nocheck
/**
 * Tests that memory_store creates event_log entries (Issue #150).
 *
 * Uses a real FactsDB + EventLog and a minimal mock API to register the tool
 * and call its execute handler directly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { registerMemoryTools } from "../tools/memory-tools.js";

const { FactsDB, EventLog } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockApi() {
	const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
	return {
		registerTool(opts: Record<string, unknown>, _options?: unknown) {
			tools.set(opts.name as string, {
				execute: opts.execute as (...args: unknown[]) => unknown,
			});
		},
		getTool(name: string) {
			return tools.get(name);
		},
		logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
		context: { sessionId: "test-session-123", agentId: "test-agent" },
	};
}

function makeMockVectorDb() {
	return {
		hasDuplicate: vi.fn().mockResolvedValue(false),
		store: vi.fn().mockResolvedValue(undefined),
		search: vi.fn().mockResolvedValue([]),
		close: vi.fn(),
	};
}

function makeMockEmbeddings() {
	return {
		embed: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
		embedBatch: vi.fn().mockResolvedValue([]),
		dimensions: 384,
		modelName: "mock-model",
	};
}

function makeMockOpenAI() {
	return {} as never;
}

function makeCfg() {
	return {
		captureMaxChars: 2000,
		categories: ["fact", "preference", "decision"],
		store: { classifyBeforeWrite: false },
		multiAgent: {
			orchestratorId: "main",
			defaultStoreScope: "global",
			strictAgentScoping: false,
		},
		graph: {
			enabled: false,
			autoLink: false,
			autoLinkLimit: 5,
			autoLinkMinScore: 0.5,
			useInRecall: false,
			maxTraversalDepth: 2,
			coOccurrenceWeight: 0.5,
			autoSupersede: false,
		},
		graphRetrieval: {
			enabled: false,
			defaultExpand: false,
			maxExpandDepth: 3,
			maxExpandedResults: 20,
		},
		credentials: { enabled: false },
		autoRecall: {
			scopeFilter: null,
			summaryThreshold: 0,
			summaryMaxChars: 500,
		},
		distill: { reinforcementBoost: 0.1 },
		retrieval: { strategies: [], explicitBudgetTokens: 2000 },
		aliases: { enabled: false },
		procedures: { enabled: false },
		clusters: null,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;
let eventLog: InstanceType<typeof EventLog>;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "memory-store-event-log-test-"));
	factsDb = new FactsDB(join(tmpDir, "facts.db"));
	eventLog = new EventLog(join(tmpDir, "event-log.db"));
});

afterEach(() => {
	factsDb.close();
	eventLog.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("memory_store event_log integration", () => {
	it("appends a fact_learned event when a fact is stored", async () => {
		const api = makeMockApi();
		const vectorDb = makeMockVectorDb();
		const embeddings = makeMockEmbeddings();
		const cfg = makeCfg();
		const lastProgressiveIndexIds: string[] = [];
		const currentAgentIdRef = { value: "test-agent" };

		registerMemoryTools(
			{
				factsDb: factsDb as never,
				edictStore: null as any,
				vectorDb: vectorDb as never,
				cfg: cfg as never,
				embeddings: embeddings as never,
				openai: makeMockOpenAI(),
				wal: null,
				credentialsDb: null,
				eventLog: eventLog as never,
				lastProgressiveIndexIds,
				currentAgentIdRef,
				pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
				aliasDb: null,
			},
			api as never,
			(_params, _currentAgent, _cfg) => undefined,
			(_op, _data, _logger) => "wal-id",
			(_id, _logger) => undefined,
			async (_vdb, _fdb, _vec, _limit) => [],
		);

		const storeTool = api.getTool("memory_store");
		expect(storeTool).toBeDefined();

		await storeTool?.execute("call-1", {
			text: "The user prefers TypeScript over JavaScript",
			importance: 0.8,
			category: "preference",
		});

		const events = eventLog.getBySession("test-session-123");
		expect(events).toHaveLength(1);
		expect(events[0].eventType).toBe("preference_expressed");
		expect(events[0].content.source).toBe("memory_store");
		expect(events[0].content.category).toBe("preference");
		expect(events[0].sessionId).toBe("test-session-123");
	});

	it("does not throw when eventLog is null", async () => {
		const api = makeMockApi();
		const vectorDb = makeMockVectorDb();
		const embeddings = makeMockEmbeddings();
		const cfg = makeCfg();

		registerMemoryTools(
			{
				factsDb: factsDb as never,
				edictStore: null as any,
				vectorDb: vectorDb as never,
				cfg: cfg as never,
				embeddings: embeddings as never,
				openai: makeMockOpenAI(),
				wal: null,
				credentialsDb: null,
				eventLog: null,
				lastProgressiveIndexIds: [],
				currentAgentIdRef: { value: "test-agent" },
				pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
				aliasDb: null,
			},
			api as never,
			(_params, _currentAgent, _cfg) => undefined,
			(_op, _data, _logger) => "wal-id",
			(_id, _logger) => undefined,
			async (_vdb, _fdb, _vec, _limit) => [],
		);

		const storeTool = api.getTool("memory_store");
		await expect(
			storeTool?.execute("call-2", {
				text: "Null event log should not throw",
				importance: 0.7,
			}),
		).resolves.toBeDefined();
	});

	it("records the stored factId in the event content", async () => {
		const api = makeMockApi();
		const vectorDb = makeMockVectorDb();
		const embeddings = makeMockEmbeddings();
		const cfg = makeCfg();

		registerMemoryTools(
			{
				factsDb: factsDb as never,
				edictStore: null as any,
				vectorDb: vectorDb as never,
				cfg: cfg as never,
				embeddings: embeddings as never,
				openai: makeMockOpenAI(),
				wal: null,
				credentialsDb: null,
				eventLog: eventLog as never,
				lastProgressiveIndexIds: [],
				currentAgentIdRef: { value: "test-agent" },
				pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
				aliasDb: null,
			},
			api as never,
			(_params, _currentAgent, _cfg) => undefined,
			(_op, _data, _logger) => "wal-id",
			(_id, _logger) => undefined,
			async (_vdb, _fdb, _vec, _limit) => [],
		);

		const storeTool = api.getTool("memory_store");
		const result = (await storeTool?.execute("call-3", {
			text: "Event should contain the new fact ID",
			importance: 0.7,
			entity: "FactIdTest",
		})) as { details: { id: string } };

		const storedFactId = result.details.id;
		const events = eventLog.getBySession("test-session-123");
		const factLearned = events.find((e) => e.eventType === "fact_learned");
		expect(factLearned).toBeDefined();
		expect(factLearned?.content.factId).toBe(storedFactId);
		expect(factLearned?.entities).toEqual(["FactIdTest"]);
	});
});
