import { describe, expect, it } from "vitest";
import { assertEmbeddingDimensionsForVectorDb } from "../services/bootstrap.js";

describe("assertEmbeddingDimensionsForVectorDb (#944)", () => {
  it("accepts positive integers", () => {
    expect(() => assertEmbeddingDimensionsForVectorDb(1536)).not.toThrow();
    expect(() => assertEmbeddingDimensionsForVectorDb(1)).not.toThrow();
  });

  it("rejects NaN, non-integer, and non-positive values", () => {
    expect(() => assertEmbeddingDimensionsForVectorDb(Number.NaN)).toThrow(/Invalid embedding dimensions/);
    expect(() => assertEmbeddingDimensionsForVectorDb(1.5)).toThrow(/Invalid embedding dimensions/);
    expect(() => assertEmbeddingDimensionsForVectorDb(0)).toThrow(/Invalid embedding dimensions/);
    expect(() => assertEmbeddingDimensionsForVectorDb(-8)).toThrow(/Invalid embedding dimensions/);
  });
});
