import { describe, expect, it, vi } from "vitest";
import { deleteVectorsForFactIds, storeCanonicalVectorForFact } from "../services/vector-maintenance.js";

describe("deleteVectorsForFactIds", () => {
  it("uses deleteMany when available", async () => {
    const deleteMany = vi.fn().mockResolvedValue(2);
    const result = await deleteVectorsForFactIds(
      { delete: vi.fn(), deleteMany } as never,
      ["a", "a", "b"],
      { operation: "test-op" },
    );
    expect(deleteMany).toHaveBeenCalledWith(["a", "b"]);
    expect(result).toEqual({ attempted: 2, deleted: 2, failed: 0 });
  });

  it("falls back to per-id delete when deleteMany fails", async () => {
    const deleteMany = vi.fn().mockRejectedValue(new Error("bulk failed"));
    const del = vi.fn().mockResolvedValue(true);
    const result = await deleteVectorsForFactIds(
      { delete: del, deleteMany } as never,
      ["a", "b"],
      { operation: "test-op" },
    );
    expect(del).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ attempted: 2, deleted: 2, failed: 0 });
  });
});

describe("storeCanonicalVectorForFact", () => {
  it("stores a canonical vector with the fact id and records embedding metadata after success", async () => {
    const store = vi.fn().mockResolvedValue("fact-1");
    const setEmbeddingModel = vi.fn();

    await expect(
      storeCanonicalVectorForFact({
        vectorDb: { store },
        factsDb: { setEmbeddingModel },
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
  });

  it("does not record embedding metadata when vector storage fails", async () => {
    const storeError = new Error("lance write failed");
    const store = vi.fn().mockRejectedValue(storeError);
    const setEmbeddingModel = vi.fn();

    await expect(
      storeCanonicalVectorForFact({
        vectorDb: { store },
        factsDb: { setEmbeddingModel },
        factId: "fact-2",
        text: "new fact",
        vector: [0.3, 0.4],
        importance: 0.6,
        category: "other",
        embeddingModel: "text-embedding-test",
      }),
    ).rejects.toThrow("lance write failed");

    expect(setEmbeddingModel).not.toHaveBeenCalled();
  });

  it("does not record embedding metadata when LanceDB is unavailable", async () => {
    const store = vi.fn().mockResolvedValue("fact-3");
    const setEmbeddingModel = vi.fn();

    await expect(
      storeCanonicalVectorForFact({
        vectorDb: { store, isLanceDbAvailable: () => false },
        factsDb: { setEmbeddingModel },
        factId: "fact-3",
        text: "fallback fact",
        vector: [0.9, 0.1],
        importance: 0.5,
        category: "other",
        embeddingModel: "text-embedding-test",
      }),
    ).resolves.toBe("fact-3");

    expect(setEmbeddingModel).not.toHaveBeenCalled();
  });
});
