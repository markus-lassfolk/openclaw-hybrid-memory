/**
 * Benchmark: procedure-feedback feature — integration tests
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	benchmark,
	shadowBenchmark,
	testAccuracy,
} from "../../../benchmark/features/procedure-feedback.js";
import type { BenchmarkContext } from "../../../benchmark/shadow-eval.js";

function makeCtx(): BenchmarkContext {
	const tmpDir = mkdtempSync(join(tmpdir(), "bench-proc-test-"));
	return { dbPath: join(tmpDir, "facts.db") };
}

describe("procedure-feedback benchmark", () => {
	describe("benchmark()", () => {
		it("returns valid latency stats for procedure recall", () => {
			const ctx = makeCtx();
			try {
				const stats = benchmark(ctx, 20);
				expect(stats.p50).toBeGreaterThanOrEqual(0);
				expect(stats.p95).toBeGreaterThanOrEqual(stats.p50);
				expect(stats.p99).toBeGreaterThanOrEqual(stats.p95);
				expect(stats.samples).toBe(20);
			} finally {
				rmSync(join(tmpdir(), "bench-proc-test-"), {
					recursive: true,
					force: true,
				});
			}
		});
	});

	describe("shadowBenchmark()", () => {
		it("compares versioned vs flat recall", () => {
			const ctx = makeCtx();
			try {
				const result = shadowBenchmark(ctx, 20);
				expect(result.baselineStats.samples).toBe(20);
				expect(result.shadowStats.samples).toBe(20);
				expect(typeof result.deltaMs).toBe("number");
			} finally {
				rmSync(join(tmpdir(), "bench-proc-test-"), {
					recursive: true,
					force: true,
				});
			}
		});
	});

	describe("testAccuracy()", () => {
		it("returns featureOn with versioned recall and featureOff with flat recall", async () => {
			const ctx = makeCtx();
			try {
				const result = await testAccuracy(ctx);
				expect(typeof result.featureOn).toBe("string");
				expect(typeof result.featureOff).toBe("string");
				expect(typeof result.prompt).toBe("string");

				// Versioned recall should pick the best-scored procedure
				expect(result.featureOn).toContain("Versioned recall");
				expect(result.featureOn).toContain("nibe");

				// Flat recall just picks first match
				expect(result.featureOff).toContain("Flat recall");
			} finally {
				rmSync(join(tmpdir(), "bench-proc-test-"), {
					recursive: true,
					force: true,
				});
			}
		});

		it("versioned recall picks highest-confidence procedure", async () => {
			const ctx = makeCtx();
			try {
				const result = await testAccuracy(ctx);
				// For "nibe system status" query there are 3 versions.
				// Versioned recall sorts by confidence desc, then successCount desc.
				// Confidences: 0.89, 0.86, 0.75 — picks confidence=0.89 (successes=8).
				expect(result.featureOn).toContain("confidence=0.89");
				expect(result.featureOn).toContain("successes=8");
			} finally {
				rmSync(join(tmpdir(), "bench-proc-test-"), {
					recursive: true,
					force: true,
				});
			}
		});
	});
});
