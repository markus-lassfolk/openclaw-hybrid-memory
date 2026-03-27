/**
 * Benchmark: frequency-autosave feature — integration tests
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { benchmark, shadowBenchmark, testAccuracy } from "../../../benchmark/features/frequency-autosave.js";
import type { BenchmarkContext } from "../../../benchmark/shadow-eval.js";

function makeCtx(): BenchmarkContext {
  const tmpDir = mkdtempSync(join(tmpdir(), "bench-freq-test-"));
  return { dbPath: join(tmpDir, "facts.db") };
}

describe("frequency-autosave benchmark", () => {
  describe("benchmark()", () => {
    it("returns valid latency stats for mention extraction", () => {
      const ctx = makeCtx();
      try {
        const stats = benchmark(ctx, 20);
        expect(stats.p50).toBeGreaterThanOrEqual(0);
        expect(stats.p95).toBeGreaterThanOrEqual(stats.p50);
        expect(stats.p99).toBeGreaterThanOrEqual(stats.p95);
        expect(stats.samples).toBe(20);
      } finally {
        rmSync(join(tmpdir(), "bench-freq-test-"), { recursive: true, force: true });
      }
    });
  });

  describe("shadowBenchmark()", () => {
    it("returns baseline vs shadow comparison", () => {
      const ctx = makeCtx();
      try {
        const result = shadowBenchmark(ctx, 20);
        expect(result.baselineStats.samples).toBe(20);
        expect(result.shadowStats.samples).toBe(20);
        expect(typeof result.deltaMs).toBe("number");
        // Shadow (with tracking) should be slower or equal
        expect(result.deltaMs).toBeGreaterThanOrEqual(0);
      } finally {
        rmSync(join(tmpdir(), "bench-freq-test-"), { recursive: true, force: true });
      }
    });
  });

  describe("testAccuracy()", () => {
    it("returns featureOn with entity mentions and featureOff without", async () => {
      const ctx = makeCtx();
      try {
        const result = await testAccuracy(ctx);
        expect(typeof result.featureOn).toBe("string");
        expect(typeof result.featureOff).toBe("string");
        expect(typeof result.prompt).toBe("string");
        // Feature ON should find mentions
        expect(result.featureOn).toContain("Found");
        expect(result.featureOn).toContain("Nibe");
        // Feature OFF should show word count without entity tracking
        expect(result.featureOff).toContain("Word count");
      } finally {
        rmSync(join(tmpdir(), "bench-freq-test-"), { recursive: true, force: true });
      }
    });
  });
});
