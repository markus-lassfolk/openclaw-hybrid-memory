import { describe, expect, it, vi } from "vitest";
import { storeCanonicalVectorForFact } from "../services/vector-maintenance.js";

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
});
