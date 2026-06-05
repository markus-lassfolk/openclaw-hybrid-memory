import { describe, expect, it, vi } from "vitest";
import { deleteVectorsForFactIds, storeCanonicalVectorForFact } from "../services/vector-maintenance.js";

describe("deleteVectorsForFactIds", () => {
  it("skips cleanup when LanceDB backend is unavailable", async () => {
    const deleteMany = vi.fn();
    const del = vi.fn();
    const result = await deleteVectorsForFactIds(
      { delete: del, deleteMany, isLanceDbAvailable: () => false } as never,
      ["a", "b"],
      { operation: "test-op" },
    );
    expect(deleteMany).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 0, deleted: 0, failed: 0 });
  });

  it("uses deleteMany when available", async () => {
    const deleteMany = vi.fn().mockResolvedValue(2);
    const result = await deleteVectorsForFactIds({ delete: vi.fn(), deleteMany } as never, ["a", "a", "b"], {
      operation: "test-op",
    });
    expect(deleteMany).toHaveBeenCalledWith(["a", "b"]);
    expect(result).toEqual({ attempted: 2, deleted: 2, failed: 0 });
  });

  it("reports partial bulk deletion counts as failed", async () => {
    const deleteMany = vi.fn().mockResolvedValue(1);
    const result = await deleteVectorsForFactIds({ delete: vi.fn(), deleteMany } as never, ["a", "b"], {
      operation: "test-op",
    });
    expect(result).toEqual({ attempted: 2, deleted: 1, failed: 1 });
  });

  it("falls back to per-id delete when deleteMany fails", async () => {
    const deleteMany = vi.fn().mockRejectedValue(new Error("bulk failed"));
    const del = vi.fn().mockResolvedValue(true);
    const result = await deleteVectorsForFactIds({ delete: del, deleteMany } as never, ["a", "b"], {
      operation: "test-op",
    });
    expect(del).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ attempted: 2, deleted: 2, failed: 0 });
  });

  it("treats zero-result bulk cleanup as skipped when LanceDB became unavailable", async () => {
    const deleteMany = vi.fn().mockResolvedValue(0);
    const result = await deleteVectorsForFactIds(
      {
        delete: vi.fn(),
        deleteMany,
        isLanceDbAvailable: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
      } as never,
      ["a", "b"],
      { operation: "test-op" },
    );
    expect(result).toEqual({ attempted: 0, deleted: 0, failed: 0 });
  });
});

describe("storeCanonicalVectorForFact", () => {
  it("stores a canonical vector with the fact id and records embedding metadata after success", async () => {
    const store = vi.fn().mockResolvedValue("fact-1");
    const setEmbeddingModel = vi.fn();
    const storeEmbedding = vi.fn();

    await expect(
      storeCanonicalVectorForFact({
        vectorDb: { store },
        factsDb: { setEmbeddingModel, storeEmbedding },
        factId: "fact-1",
        text: "updated fact",
        why: "because",
        vector: [0.1, 0.2],
        importance: 0.8,
        category: "decision",
        embeddingModel: "text-embedding-test",
      }),
    ).resolves.toBe("fact-1");

    expect(store).toHaveBeenCalledWith({
      id: "fact-1",
      text: "updated fact",
      why: "because",
      vector: [0.1, 0.2],
      importance: 0.8,
      category: "decision",
    });
    expect(setEmbeddingModel).toHaveBeenCalledWith("fact-1", "text-embedding-test");
    expect(storeEmbedding).toHaveBeenCalledWith(
      "fact-1",
      "text-embedding-test",
      "canonical",
      new Float32Array([0.1, 0.2]),
      2,
    );
  });

  it("does not record embedding metadata when vector storage fails", async () => {
    const storeError = new Error("lance write failed");
    const store = vi.fn().mockRejectedValue(storeError);
    const setEmbeddingModel = vi.fn();
    const storeEmbedding = vi.fn();

    await expect(
      storeCanonicalVectorForFact({
        vectorDb: { store },
        factsDb: { setEmbeddingModel, storeEmbedding },
        factId: "fact-2",
        text: "new fact",
        vector: [0.3, 0.4],
        importance: 0.6,
        category: "other",
        embeddingModel: "text-embedding-test",
      }),
    ).rejects.toThrow("lance write failed");

    expect(setEmbeddingModel).not.toHaveBeenCalled();
    expect(storeEmbedding).not.toHaveBeenCalled();
  });

  it("does not abort after LanceDB success when SQLite canonical embedding persistence fails", async () => {
    const store = vi.fn().mockResolvedValue("fact-4");
    const setEmbeddingModel = vi.fn();
    const storeEmbedding = vi.fn().mockImplementation(() => {
      throw new Error("sqlite write failed");
    });

    await expect(
      storeCanonicalVectorForFact({
        vectorDb: { store },
        factsDb: { setEmbeddingModel, storeEmbedding },
        factId: "fact-4",
        text: "canonical fact",
        vector: [0.2, 0.8],
        importance: 0.7,
        category: "fact",
        embeddingModel: "text-embedding-test",
      }),
    ).resolves.toBe("fact-4");

    expect(store).toHaveBeenCalledWith({
      id: "fact-4",
      text: "canonical fact",
      why: undefined,
      vector: [0.2, 0.8],
      importance: 0.7,
      category: "fact",
    });
    expect(setEmbeddingModel).toHaveBeenCalledWith("fact-4", "text-embedding-test");
    expect(storeEmbedding).toHaveBeenCalledOnce();
  });

  it("does not record embedding metadata when LanceDB is unavailable", async () => {
    const store = vi.fn().mockResolvedValue("fact-3");
    const setEmbeddingModel = vi.fn();
    const storeEmbedding = vi.fn();

    await expect(
      storeCanonicalVectorForFact({
        vectorDb: { store, isLanceDbAvailable: () => false },
        factsDb: { setEmbeddingModel, storeEmbedding },
        factId: "fact-3",
        text: "fallback fact",
        vector: [0.9, 0.1],
        importance: 0.5,
        category: "other",
        embeddingModel: "text-embedding-test",
      }),
    ).resolves.toBe("fact-3");

    expect(setEmbeddingModel).not.toHaveBeenCalled();
    expect(storeEmbedding).not.toHaveBeenCalled();
  });
});
