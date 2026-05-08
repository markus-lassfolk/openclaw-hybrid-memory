/**
 * Benchmark: procedure feedback (procedure versioning and effectiveness scoring)
 *
 * Tests procedure recall with versioning:
 *   - extractProceduresFromSessions: parse session JSONL → procedure entries
 *   - recall effectiveness: find best matching procedure for a task
 *
 * Shadow mode: compare recall quality with procedure versioning (multiple versions
 * ranked by successCount) vs. no versioning (flat list).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchmarkContext, LatencyStats } from "../shadow-eval.js";
import { measureLatency, shadowMeasure } from "../shadow-eval.js";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "bench-proc-"));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface ProcFixture {
  tmpDir: string;
  procedures: Array<{
    taskPattern: string;
    recipeJson: string;
    procedureType: "positive" | "negative";
    successCount: number;
    failureCount: number;
    confidence: number;
  }>;
}

function createFixture(): ProcFixture {
  const tmpDir = makeTempDir();

  // Simulate a set of procedures with varying success rates (versioning proxy)
  const procedures = [
    {
      taskPattern: "check nibe system status",
      recipeJson: JSON.stringify([
        { tool: "exec", args: { command: "curl -s http://nibe.local/status" }, summary: "fetch status" },
        { tool: "exec", args: { command: "jq '.status'" }, summary: "parse JSON" },
      ]),
      procedureType: "positive" as const,
      successCount: 8,
      failureCount: 1,
      confidence: 0.89,
    },
    {
      taskPattern: "check nibe system status",
      recipeJson: JSON.stringify([
        { tool: "exec", args: { command: "curl http://nibe.local/api/status" }, summary: "fetch status v2" },
        { tool: "exec", args: { command: "cat status.json" }, summary: "read file" },
      ]),
      procedureType: "positive" as const,
      successCount: 3,
      failureCount: 0,
      confidence: 0.75,
    },
    {
      taskPattern: "check nibe system status",
      recipeJson: JSON.stringify([{ tool: "exec", args: { command: "nibe-cli status" }, summary: "use CLI" }]),
      procedureType: "positive" as const,
      successCount: 12,
      failureCount: 2,
      confidence: 0.86,
    },
    {
      taskPattern: "deploy to production",
      recipeJson: JSON.stringify([
        { tool: "exec", args: { command: "git push origin main" }, summary: "push" },
        { tool: "exec", args: { command: "./deploy.sh" }, summary: "run deploy" },
      ]),
      procedureType: "positive" as const,
      successCount: 5,
      failureCount: 4,
      confidence: 0.56,
    },
    {
      taskPattern: "deploy to production",
      recipeJson: JSON.stringify([
        { tool: "exec", args: { command: "git tag v$(date +%Y%m%d%H%M)" }, summary: "tag" },
        { tool: "exec", args: { command: "git push --tags" }, summary: "push tags" },
        { tool: "exec", args: { command: "./deploy.sh --staged" }, summary: "deploy staged" },
      ]),
      procedureType: "positive" as const,
      successCount: 7,
      failureCount: 1,
      confidence: 0.87,
    },
    {
      taskPattern: "fix merge conflict",
      recipeJson: JSON.stringify([
        { tool: "exec", args: { command: "git status" }, summary: "check status" },
        { tool: "exec", args: { command: "git diff --name-only" }, summary: "find conflicts" },
      ]),
      procedureType: "negative" as const,
      successCount: 2,
      failureCount: 6,
      confidence: 0.25,
    },
  ];

  return { tmpDir, procedures };
}

// ---------------------------------------------------------------------------
// recallBestProcedure — versioned (uses successCount as tiebreaker)
// ---------------------------------------------------------------------------

function recallBestProcedureVersioned(
  procedures: ProcFixture["procedures"],
  query: string,
): { taskPattern: string; recipe: unknown[]; confidence: number; successCount: number } | null {
  // Filter to positive procedures matching query
  const matches = procedures.filter(
    (p) => p.procedureType === "positive" && p.taskPattern.toLowerCase().includes(query.toLowerCase()),
  );
  if (matches.length === 0) return null;

  // Sort by confidence desc, then by successCount desc (versioning tiebreaker)
  matches.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.successCount - a.successCount;
  });

  const best = matches[0];
  return {
    taskPattern: best.taskPattern,
    recipe: JSON.parse(best.recipeJson),
    confidence: best.confidence,
    successCount: best.successCount,
  };
}

// ---------------------------------------------------------------------------
// recallBestProcedure — flat (no versioning, just first match)
// ---------------------------------------------------------------------------

function recallBestProcedureFlat(
  procedures: ProcFixture["procedures"],
  query: string,
): { taskPattern: string; recipe: unknown[]; confidence: number } | null {
  const match = procedures.find(
    (p) => p.procedureType === "positive" && p.taskPattern.toLowerCase().includes(query.toLowerCase()),
  );
  if (!match) return null;
  return {
    taskPattern: match.taskPattern,
    recipe: JSON.parse(match.recipeJson),
    confidence: match.confidence,
  };
}

// ---------------------------------------------------------------------------
// benchmark()
// ---------------------------------------------------------------------------

export function benchmark(_ctx: BenchmarkContext, iterations: number): LatencyStats {
  const fixture = createFixture();
  const query = "nibe system status";

  const recallFn = () => recallBestProcedureVersioned(fixture.procedures, query);

  fixture.tmpDir && rmSync(fixture.tmpDir, { recursive: true, force: true });

  const { p50, p95, p99, samples } = measureLatency(recallFn, iterations, 3);
  return { p50, p95, p99, samples };
}

// ---------------------------------------------------------------------------
// shadowBenchmark()
// ---------------------------------------------------------------------------

export function shadowBenchmark(
  _ctx: BenchmarkContext,
  iterations: number,
): { baselineStats: LatencyStats; shadowStats: LatencyStats; deltaMs: number } {
  const fixture = createFixture();
  const query = "nibe system status";

  const versionedRecall = () => recallBestProcedureVersioned(fixture.procedures, query);
  const flatRecall = () => recallBestProcedureFlat(fixture.procedures, query);

  const result = shadowMeasure(flatRecall, versionedRecall, iterations, 3);

  rmSync(fixture.tmpDir, { recursive: true, force: true });
  return result;
}

// ---------------------------------------------------------------------------
// testAccuracy()
// ---------------------------------------------------------------------------

export async function testAccuracy(
  _ctx: BenchmarkContext,
): Promise<{ featureOn: string; featureOff: string; prompt: string }> {
  const fixture = createFixture();
  const prompt = 'Task: "check nibe system status". Which procedure should be used?';

  const onResult = recallBestProcedureVersioned(fixture.procedures, "nibe system status");
  const offResult = recallBestProcedureFlat(fixture.procedures, "nibe system status");

  const featureOn = onResult
    ? `Versioned recall: "${onResult.taskPattern}" (confidence=${onResult.confidence.toFixed(2)}, successes=${onResult.successCount}, steps=${onResult.recipe.length})`
    : "No matching procedure found.";

  const featureOff = offResult
    ? `Flat recall: "${offResult.taskPattern}" (confidence=${offResult.confidence.toFixed(2)}, steps=${offResult.recipe.length})`
    : "No matching procedure found.";

  rmSync(fixture.tmpDir, { recursive: true, force: true });

  return { featureOn, featureOff, prompt };
}
