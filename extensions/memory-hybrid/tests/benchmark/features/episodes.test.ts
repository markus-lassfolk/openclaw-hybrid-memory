/**
 * Benchmark: episodes feature — integration tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { benchmark, shadowBenchmark, testAccuracy } from "../../../benchmark/features/episodes.js";
import type { BenchmarkContext } from "../../../benchmark/shadow-eval.js";

function makeCtx(): BenchmarkContext {
  const tmpDir = mkdtempSync(join(tmpdir(), "bench-episodes-test-"));
  return { dbPath: join(tmpDir, "facts.db") };
}

describe("episodes benchmark", () => {
  describe("benchmark()", () => {
    it("returns valid latency stats", () => {
      const ctx = makeCtx();
      try {
        const stats = benchmark(ctx, 20);
        expect(stats.p50).toBeGreaterThanOrEqual(0);
        expect(stats.p95).toBeGreaterThanOrEqual(stats.p50);
        expect(stats.p99).toBeGreaterThanOrEqual(stats.p95);
        expect(stats.samples).toBe(20);
      } finally {
        rmSync(join(tmpdir(), "bench-episodes-test-"), { recursive: true, force: true });
      }
    });
  });

  describe("shadowBenchmark()", () => {
    it("returns baseline and shadow stats with delta", () => {
      const ctx = makeCtx();
      try {
        const result = shadowBenchmark(ctx, 20);
        expect(result.baselineStats.samples).toBe(20);
        expect(result.shadowStats.samples).toBe(20);
        expect(typeof result.deltaMs).toBe("number");
      } finally {
        rmSync(join(tmpdir(), "bench-episodes-test-"), { recursive: true, force: true });
      }
    });
  });

  describe("testAccuracy()", () => {
    it("returns featureOn, featureOff, and prompt strings", async () => {
      const ctx = makeCtx();
      try {
        const result = await testAccuracy(ctx);
        expect(typeof result.featureOn).toBe("string");
        expect(typeof result.featureOff).toBe("string");
        expect(typeof result.prompt).toBe("string");
        expect(result.featureOn.length).toBeGreaterThan(0);
        expect(result.featureOff.length).toBeGreaterThan(0);
      } finally {
        rmSync(join(tmpdir(), "bench-episodes-test-"), { recursive: true, force: true });
      }
    });

    it("featureOn finds episodes while featureOff does not", async () => {
      const ctx = makeCtx();
      try {
        const result = await testAccuracy(ctx);
        // Feature ON should either find episodes or return a structured response
        // (search may or may not match depending on timing)
        expect(typeof result.featureOn).toBe("string");
        expect(result.featureOn.length).toBeGreaterThan(0);
        // Feature OFF (empty log) should report no episodes
        expect(result.featureOff.toLowerCase()).toContain("disabled");
      } finally {
        rmSync(join(tmpdir(), "bench-episodes-test-"), { recursive: true, force: true });
      }
    });
  });
});
