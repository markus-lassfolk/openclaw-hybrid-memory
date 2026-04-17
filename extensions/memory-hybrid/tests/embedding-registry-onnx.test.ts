/**
 * ONNX integration tests for EmbeddingRegistry.
 */

import { describe, expect, it, vi } from "vitest";
import type { EmbeddingModelConfig } from "../config.js";
import type { EmbeddingProvider } from "../services/embeddings.js";

vi.mock("../services/embeddings.js", async () => {
	const actual = await vi.importActual<
		typeof import("../services/embeddings.js")
	>("../services/embeddings.js");
	class FakeOnnxProvider implements EmbeddingProvider {
		readonly dimensions: number;
		readonly modelName: string;
		constructor(opts: { model: string; dimensions: number }) {
			this.modelName = opts.model;
			this.dimensions = opts.dimensions;
		}
		async embed(_text: string): Promise<number[]> {
			return Array.from(
				{ length: this.dimensions },
				(_, i) => i / this.dimensions,
			);
		}
		async embedBatch(texts: string[]): Promise<number[][]> {
			const vec = await this.embed("test");
			return texts.map(() => vec);
		}
	}
	return { ...actual, OnnxEmbeddingProvider: FakeOnnxProvider };
});

function makeMockProvider(modelName: string, dims: number): EmbeddingProvider {
	return {
		modelName,
		dimensions: dims,
		embed: vi
			.fn()
			.mockResolvedValue(Array.from({ length: dims }, (_, i) => i / dims)),
		embedBatch: vi
			.fn()
			.mockResolvedValue([Array.from({ length: dims }, (_, i) => i / dims)]),
	};
}

describe("EmbeddingRegistry — ONNX integration", () => {
	it("creates ONNX providers for onnx models", async () => {
		const { buildEmbeddingRegistry } = await import(
			"../services/embedding-registry.js"
		);
		const primary = makeMockProvider("text-embedding-3-small", 1536);
		const multiModels: EmbeddingModelConfig[] = [
			{
				name: "all-MiniLM-L6-v2",
				provider: "onnx",
				dimensions: 384,
				role: "domain",
			},
		];
		const registry = buildEmbeddingRegistry(
			primary,
			"text-embedding-3-small",
			multiModels,
		);
		const vec = await registry.embed("test", "all-MiniLM-L6-v2");
		expect(vec.length).toBe(384);
	});
});
