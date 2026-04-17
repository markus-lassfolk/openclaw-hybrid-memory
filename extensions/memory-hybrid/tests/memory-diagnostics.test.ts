import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { runMemoryDiagnostics } from "../services/memory-diagnostics.js";

const { FactsDB, VectorDB } = _testing;

class FakeEmbeddings {
	readonly dimensions = 3;
	readonly modelName = "fake-model";
	async embed(_text: string): Promise<number[]> {
		return [0.1, 0.2, 0.3];
	}
	async embedBatch(texts: string[]): Promise<number[][]> {
		return texts.map(() => [0.1, 0.2, 0.3]);
	}
}

describe("runMemoryDiagnostics", () => {
	let tmpDir: string;
	let factsDb: InstanceType<typeof FactsDB>;
	let vectorDb: InstanceType<typeof VectorDB>;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "mem-diag-test-"));
		factsDb = new FactsDB(join(tmpDir, "facts.db"));
		vectorDb = new VectorDB(join(tmpDir, "lance"), 3);
		vectorDb.open();
	});

	afterEach(() => {
		vectorDb.removeSession();
		vectorDb.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("stores a marker and validates searches", async () => {
		const result = await runMemoryDiagnostics({
			factsDb,
			vectorDb,
			embeddings: new FakeEmbeddings(),
			minScore: 0.1,
			autoRecallLimit: 5,
		});

		expect(result.markerId).toMatch(/[0-9a-f-]{36}/i);
		expect(result.structured.ok).toBe(true);
		expect(result.semantic.ok).toBe(true);
		expect(result.semantic.failReason).toBeUndefined();
		expect(result.hybrid.ok).toBe(true);
		expect(result.autoRecall.ok).toBe(true);
	});

	it("reports vector_dim_mismatch when embedding dimensions != LanceDB dimensions (#939)", async () => {
		const mismatchedEmbeddings = {
			dimensions: 5,
			modelName: "mismatched-model",
			async embed(_text: string): Promise<number[]> {
				return [0.1, 0.2, 0.3, 0.4, 0.5];
			},
			async embedBatch(texts: string[]): Promise<number[][]> {
				return texts.map(() => [0.1, 0.2, 0.3, 0.4, 0.5]);
			},
		};

		const result = await runMemoryDiagnostics({
			factsDb,
			vectorDb,
			embeddings: mismatchedEmbeddings as any,
			minScore: 0.1,
			autoRecallLimit: 5,
		});

		expect(result.semantic.ok).toBe(false);
		expect(result.semantic.failReason).toBe("vector_dim_mismatch");
	});
});
