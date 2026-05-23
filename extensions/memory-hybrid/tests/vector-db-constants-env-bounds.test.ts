/**
 * Regression tests for env-driven runtime bounds in backends/vector-db/constants.ts.
 * Verifies that VECTOR_QUERY_MAX_RESULTS and SEMANTIC_QUERY_CACHE_* env overrides
 * are correctly applied and clamped to their configured min/max ranges.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_VECTOR_QUERY_MAX_RESULTS = "OPENCLAW_HYBRID_MEM_VECTOR_QUERY_MAX_RESULTS";
const ENV_SEMANTIC_CACHE_MAX_ROWS = "OPENCLAW_HYBRID_MEM_SEMANTIC_CACHE_MAX_ROWS_PER_FILTER_KEY";
const ENV_SEMANTIC_CACHE_CANDIDATE_LIMIT = "OPENCLAW_HYBRID_MEM_SEMANTIC_CACHE_CANDIDATE_LIMIT_MAX";

async function loadConstants() {
  const mod = await import("../backends/vector-db/constants.js");
  return mod;
}

describe("vector-db/constants — env-driven runtime bounds", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env[ENV_VECTOR_QUERY_MAX_RESULTS];
    delete process.env[ENV_SEMANTIC_CACHE_MAX_ROWS];
    delete process.env[ENV_SEMANTIC_CACHE_CANDIDATE_LIMIT];
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env[ENV_VECTOR_QUERY_MAX_RESULTS];
    delete process.env[ENV_SEMANTIC_CACHE_MAX_ROWS];
    delete process.env[ENV_SEMANTIC_CACHE_CANDIDATE_LIMIT];
  });

  describe("VECTOR_QUERY_MAX_RESULTS (default 200, min 10, max 5000)", () => {
    it("uses the default value when env var is not set", async () => {
      const { VECTOR_QUERY_MAX_RESULTS } = await loadConstants();
      expect(VECTOR_QUERY_MAX_RESULTS).toBe(200);
    });

    it("applies a valid override within range", async () => {
      process.env[ENV_VECTOR_QUERY_MAX_RESULTS] = "500";
      const { VECTOR_QUERY_MAX_RESULTS } = await loadConstants();
      expect(VECTOR_QUERY_MAX_RESULTS).toBe(500);
    });

    it("clamps to minimum (10) when override is below min", async () => {
      process.env[ENV_VECTOR_QUERY_MAX_RESULTS] = "1";
      const { VECTOR_QUERY_MAX_RESULTS } = await loadConstants();
      expect(VECTOR_QUERY_MAX_RESULTS).toBe(10);
    });

    it("clamps to maximum (5000) when override exceeds max", async () => {
      process.env[ENV_VECTOR_QUERY_MAX_RESULTS] = "99999";
      const { VECTOR_QUERY_MAX_RESULTS } = await loadConstants();
      expect(VECTOR_QUERY_MAX_RESULTS).toBe(5000);
    });

    it("falls back to default when override is not a valid integer", async () => {
      process.env[ENV_VECTOR_QUERY_MAX_RESULTS] = "not-a-number";
      const { VECTOR_QUERY_MAX_RESULTS } = await loadConstants();
      expect(VECTOR_QUERY_MAX_RESULTS).toBe(200);
    });

    it("falls back to default when override is empty string", async () => {
      process.env[ENV_VECTOR_QUERY_MAX_RESULTS] = "";
      const { VECTOR_QUERY_MAX_RESULTS } = await loadConstants();
      expect(VECTOR_QUERY_MAX_RESULTS).toBe(200);
    });

    it("falls back to default when override is whitespace", async () => {
      process.env[ENV_VECTOR_QUERY_MAX_RESULTS] = "   ";
      const { VECTOR_QUERY_MAX_RESULTS } = await loadConstants();
      expect(VECTOR_QUERY_MAX_RESULTS).toBe(200);
    });
  });

  describe("SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY (default 100, min 10, max 5000)", () => {
    it("uses the default value when env var is not set", async () => {
      const { SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY } = await loadConstants();
      expect(SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY).toBe(100);
    });

    it("applies a valid override within range", async () => {
      process.env[ENV_SEMANTIC_CACHE_MAX_ROWS] = "250";
      const { SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY } = await loadConstants();
      expect(SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY).toBe(250);
    });

    it("clamps to minimum (10) when override is below min", async () => {
      process.env[ENV_SEMANTIC_CACHE_MAX_ROWS] = "0";
      const { SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY } = await loadConstants();
      expect(SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY).toBe(10);
    });

    it("clamps to maximum (5000) when override exceeds max", async () => {
      process.env[ENV_SEMANTIC_CACHE_MAX_ROWS] = "10000";
      const { SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY } = await loadConstants();
      expect(SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY).toBe(5000);
    });

    it("falls back to default when override is not a valid integer", async () => {
      process.env[ENV_SEMANTIC_CACHE_MAX_ROWS] = "abc";
      const { SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY } = await loadConstants();
      expect(SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY).toBe(100);
    });

    it("falls back to default when override is empty string or whitespace", async () => {
      process.env[ENV_SEMANTIC_CACHE_MAX_ROWS] = "  ";
      const { SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY } = await loadConstants();
      expect(SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY).toBe(100);
    });
  });

  describe("SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX (default 200, min 10, max 5000)", () => {
    it("uses the default value when env var is not set", async () => {
      const { SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX } = await loadConstants();
      expect(SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX).toBe(200);
    });

    it("applies a valid override within range", async () => {
      process.env[ENV_SEMANTIC_CACHE_CANDIDATE_LIMIT] = "1000";
      const { SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX } = await loadConstants();
      expect(SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX).toBe(1000);
    });

    it("clamps to minimum (10) when override is below min", async () => {
      process.env[ENV_SEMANTIC_CACHE_CANDIDATE_LIMIT] = "5";
      const { SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX } = await loadConstants();
      expect(SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX).toBe(10);
    });

    it("clamps to maximum (5000) when override exceeds max", async () => {
      process.env[ENV_SEMANTIC_CACHE_CANDIDATE_LIMIT] = "9999";
      const { SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX } = await loadConstants();
      expect(SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX).toBe(5000);
    });

    it("clamps to minimum when override parses to value below min (e.g. '3.7' → parseInt=3 < min 10)", async () => {
      process.env[ENV_SEMANTIC_CACHE_CANDIDATE_LIMIT] = "3.7";
      // parseFloat("3.7") would be valid, but parseInt("3.7") floors to 3, which is below min → clamped to 10
      const { SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX } = await loadConstants();
      expect(SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX).toBe(10);
    });

    it("floors float strings to the nearest integer and clamps", async () => {
      process.env[ENV_SEMANTIC_CACHE_CANDIDATE_LIMIT] = "150.9";
      // parseInt("150.9") = 150, which is within [10, 5000]
      const { SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX } = await loadConstants();
      expect(SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX).toBe(150);
    });
  });
});
