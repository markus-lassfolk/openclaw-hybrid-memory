// @ts-nocheck
/**
 * Tool registration tests for knowledge gaps (Issue #141).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import { registerUtilityTools } from "../tools/utility-tools.js";

describe("memory_gaps tool registration", () => {
	let tmpDir: string;
	let factsDb: FactsDB;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "gaps-tool-test-"));
		factsDb = new FactsDB(join(tmpDir, "facts.db"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("registers memory_gaps tool", () => {
		const registered: string[] = [];
		const fakeApi = {
			registerTool: (def: { name: string }) => {
				registered.push(def.name);
			},
			logger: { info: () => {}, warn: () => {} },
		} as unknown as Parameters<typeof registerUtilityTools>[1];

		const fakeEmbeddings = {
			embed: vi.fn(),
			embedBatch: vi.fn(),
			dimensions: 3,
			modelName: "fake",
		} as unknown as import("../services/embeddings.js").EmbeddingProvider;

		registerUtilityTools(
			{
				factsDb,
				vectorDb: {} as unknown as import("../backends/vector-db.js").VectorDB,
				embeddings: fakeEmbeddings,
				openai: {} as unknown as import("openai").default,
				cfg: {
					gaps: { enabled: true, similarityThreshold: 0.8 },
				} as unknown as import("../config.js").HybridMemoryConfig,
				wal: null,
				resolvedSqlitePath: join(tmpDir, "facts.db"),
			},
			fakeApi,
			async () => ({
				factsAnalyzed: 0,
				patternsExtracted: 0,
				patternsStored: 0,
				window: 0,
			}),
			async () => ({ rulesExtracted: 0, rulesStored: 0 }),
			async () => ({ metaExtracted: 0, metaStored: 0 }),
			() => "wal-id",
			() => {},
		);

		expect(registered).toContain("memory_gaps");
	});
});
