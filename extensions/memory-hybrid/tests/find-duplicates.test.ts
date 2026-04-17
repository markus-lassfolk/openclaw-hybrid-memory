import { describe, expect, it, vi } from "vitest";
import { runFindDuplicates } from "../services/find-duplicates.js";
import type { MemoryEntry } from "../types/memory.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id: overrides.id ?? `fact-${Math.random().toString(36).slice(2)}`,
		text: overrides.text ?? "Default fact text",
		category: overrides.category ?? "fact",
		importance: overrides.importance ?? 0.7,
		entity: overrides.entity ?? null,
		key: overrides.key ?? null,
		value: overrides.value ?? null,
		source: overrides.source ?? "test",
		createdAt: overrides.createdAt ?? Date.now(),
		decayClass: overrides.decayClass ?? "stable",
		expiresAt: overrides.expiresAt ?? null,
		lastConfirmedAt: overrides.lastConfirmedAt ?? Date.now(),
		confidence: overrides.confidence ?? 0.6,
		...overrides,
	};
}

const logger = { info: vi.fn(), warn: vi.fn() };

describe("runFindDuplicates", () => {
	it("uses embedBatch instead of per-item embed calls", async () => {
		const facts = [
			makeEntry({ id: "a", text: "User prefers TypeScript" }),
			makeEntry({ id: "b", text: "User likes TypeScript" }),
		];
		const factsDb = {
			getFactsForConsolidation: vi.fn().mockReturnValue(facts),
		};
		const embedBatch = vi.fn().mockResolvedValue([
			[1, 0],
			[0.9, 0.1],
		]);
		const embeddings = {
			embedBatch,
			embed: vi.fn(),
			dimensions: 2,
			modelName: "test",
		};
		const vectorDb = { search: vi.fn().mockResolvedValue([]) };

		await runFindDuplicates(
			factsDb as never,
			vectorDb as never,
			embeddings,
			{ threshold: 0.8, includeStructured: false, limit: 100 },
			logger,
		);

		// embedBatch called once for both texts, NOT twice as individual calls
		expect(embedBatch).toHaveBeenCalledTimes(1);
		expect(embedBatch).toHaveBeenCalledWith([
			"User prefers TypeScript",
			"User likes TypeScript",
		]);
	});

	it("reports pairs found by vector search", async () => {
		const facts = [
			makeEntry({ id: "a", text: "Fact A" }),
			makeEntry({ id: "b", text: "Fact B" }),
		];
		const factsDb = {
			getFactsForConsolidation: vi.fn().mockReturnValue(facts),
		};
		const embeddings = {
			embedBatch: vi.fn().mockResolvedValue([
				[1, 0],
				[0.95, 0.1],
			]),
			embed: vi.fn(),
			dimensions: 2,
			modelName: "test",
		};
		const vectorDb = {
			search: vi
				.fn()
				.mockImplementation(async () => [
					{ entry: facts[1], score: 0.95, backend: "lancedb" as const },
				]),
		};

		const result = await runFindDuplicates(
			factsDb as never,
			vectorDb as never,
			embeddings,
			{ threshold: 0.8, includeStructured: false, limit: 100 },
			logger,
		);

		expect(result.pairs).toHaveLength(1);
		expect(result.pairs[0]).toMatchObject({
			idA: "a",
			idB: "b",
			score: 0.95,
			textA: "Fact A",
			textB: "Fact B",
		});
		expect(result.candidatesCount).toBe(2);
	});

	it("handles partial embedding failure — skips facts where embedBatch returns null for their slot", async () => {
		const facts = [
			makeEntry({ id: "a", text: "Fact A" }),
			makeEntry({ id: "b", text: "Fact B" }),
			makeEntry({ id: "c", text: "Fact C" }),
		];
		const factsDb = {
			getFactsForConsolidation: vi.fn().mockReturnValue(facts),
		};
		// embedBatch returns null for the middle item
		const embedBatch = vi.fn().mockResolvedValue([[1, 0], null, [0, 1]]);
		const embeddings = {
			embedBatch,
			embed: vi.fn(),
			dimensions: 2,
			modelName: "test",
		};
		const vectorDb = { search: vi.fn().mockResolvedValue([]) };
		const warnLogger = { info: vi.fn(), warn: vi.fn() };

		const result = await runFindDuplicates(
			factsDb as never,
			vectorDb as never,
			embeddings,
			{ threshold: 0.8, includeStructured: false, limit: 100 },
			warnLogger,
		);

		// Fact b skipped due to null embedding
		expect(warnLogger.warn).toHaveBeenCalledWith(
			expect.stringContaining("skipping fact b"),
		);
		// vectorDb.search called only for the 2 valid vectors
		expect(vectorDb.search).toHaveBeenCalledTimes(2);
		expect(result.candidatesCount).toBe(3);
	});

	it("handles whole batch failure — returns empty pairs gracefully and logs single batch warning", async () => {
		const facts = [
			makeEntry({ id: "a", text: "Fact A" }),
			makeEntry({ id: "b", text: "Fact B" }),
		];
		const factsDb = {
			getFactsForConsolidation: vi.fn().mockReturnValue(facts),
		};
		const embedBatch = vi
			.fn()
			.mockRejectedValue(new Error("embedding provider unavailable"));
		const embeddings = {
			embedBatch,
			embed: vi.fn(),
			dimensions: 2,
			modelName: "test",
		};
		const vectorDb = { search: vi.fn() };
		const warnLogger = { info: vi.fn(), warn: vi.fn() };

		const result = await runFindDuplicates(
			factsDb as never,
			vectorDb as never,
			embeddings,
			{ threshold: 0.8, includeStructured: false, limit: 100 },
			warnLogger,
		);

		// No pairs found, no crash
		expect(result.pairs).toHaveLength(0);
		// vectorDb.search never called — no valid vectors
		expect(vectorDb.search).not.toHaveBeenCalled();
		// Single batch-level warning, not per-fact spam
		const warnCalls = warnLogger.warn.mock.calls.map((c: string[]) => c[0]);
		expect(warnCalls.some((m: string) => m.includes("skipping batch of"))).toBe(
			true,
		);
		expect(warnCalls.every((m: string) => !m.includes("skipping fact"))).toBe(
			true,
		);
	});

	it("all batches fail — graceful degradation with zero pairs", async () => {
		const facts = Array.from({ length: 25 }, (_, i) =>
			makeEntry({ id: `f${i}`, text: `Fact ${i}` }),
		);
		const factsDb = {
			getFactsForConsolidation: vi.fn().mockReturnValue(facts),
		};
		const embedBatch = vi
			.fn()
			.mockRejectedValue(new Error("all providers failed"));
		const embeddings = {
			embedBatch,
			embed: vi.fn(),
			dimensions: 2,
			modelName: "test",
		};
		const vectorDb = { search: vi.fn() };

		const result = await runFindDuplicates(
			factsDb as never,
			vectorDb as never,
			embeddings,
			{ threshold: 0.8, includeStructured: false, limit: 100 },
			logger,
		);

		// Both batches (20 + 5) fail — embedBatch called twice
		expect(embedBatch).toHaveBeenCalledTimes(2);
		expect(result.pairs).toHaveLength(0);
		expect(vectorDb.search).not.toHaveBeenCalled();
	});

	it("batches 20 items at a time — does not call embedBatch per-item", async () => {
		const facts = Array.from({ length: 35 }, (_, i) =>
			makeEntry({ id: `f${i}`, text: `Fact ${i}` }),
		);
		const factsDb = {
			getFactsForConsolidation: vi.fn().mockReturnValue(facts),
		};
		const embedBatch = vi
			.fn()
			.mockResolvedValueOnce(Array.from({ length: 20 }, (_, i) => [i, 0]))
			.mockResolvedValueOnce(Array.from({ length: 15 }, (_, i) => [i + 20, 0]));
		const embeddings = {
			embedBatch,
			embed: vi.fn(),
			dimensions: 2,
			modelName: "test",
		};
		const vectorDb = { search: vi.fn().mockResolvedValue([]) };

		await runFindDuplicates(
			factsDb as never,
			vectorDb as never,
			embeddings,
			{ threshold: 0.8, includeStructured: false, limit: 100 },
			logger,
		);

		// Should be called exactly twice (once per batch of 20), not 35 times
		expect(embedBatch).toHaveBeenCalledTimes(2);
		expect(embedBatch.mock.calls[0][0]).toHaveLength(20);
		expect(embedBatch.mock.calls[1][0]).toHaveLength(15);
	});

	it("returns early when fewer than 2 candidate facts", async () => {
		const facts = [makeEntry({ id: "a", text: "Only one fact" })];
		const factsDb = {
			getFactsForConsolidation: vi.fn().mockReturnValue(facts),
		};
		const embedBatch = vi.fn();
		const embeddings = {
			embedBatch,
			embed: vi.fn(),
			dimensions: 2,
			modelName: "test",
		};
		const vectorDb = { search: vi.fn() };

		const result = await runFindDuplicates(
			factsDb as never,
			vectorDb as never,
			embeddings,
			{ threshold: 0.8, includeStructured: false, limit: 100 },
			logger,
		);

		expect(result.pairs).toHaveLength(0);
		expect(result.candidatesCount).toBe(1);
		expect(embedBatch).not.toHaveBeenCalled();
	});

	it("skips structured facts when includeStructured is false", async () => {
		const facts = [
			// key: "email" is recognized as structured by isStructuredForConsolidation
			makeEntry({
				id: "a",
				text: "user@example.com",
				entity: "user",
				key: "email",
				value: "user@example.com",
			}),
			makeEntry({ id: "b", text: "Prefers dark mode" }),
			makeEntry({ id: "c", text: "Uses VSCode" }),
		];
		const factsDb = {
			getFactsForConsolidation: vi.fn().mockReturnValue(facts),
		};
		const embedBatch = vi.fn().mockResolvedValue([
			[1, 0],
			[0, 1],
		]);
		const embeddings = {
			embedBatch,
			embed: vi.fn(),
			dimensions: 2,
			modelName: "test",
		};
		const vectorDb = { search: vi.fn().mockResolvedValue([]) };

		const result = await runFindDuplicates(
			factsDb as never,
			vectorDb as never,
			embeddings,
			{ threshold: 0.8, includeStructured: false, limit: 100 },
			logger,
		);

		// Only 2 non-structured facts → embedBatch called with 2 texts
		expect(embedBatch).toHaveBeenCalledWith([
			"Prefers dark mode",
			"Uses VSCode",
		]);
		expect(result.skippedStructured).toBe(1);
		expect(result.candidatesCount).toBe(2);
	});
});
