/**
 * Regression test (loop iteration 79) for cli/cmd-backfill.ts:
 *
 * `runBackfillForCli` (and its sibling `runIngestFilesForCli`) didn't increment the
 * `skipped` counter when `factsDb.storeWithResult(...)` itself reported `skipped: true`
 * (a pre-store-guard rejection, e.g. text that looks like an LLM classifier artifact) —
 * only the *other* skip branch (`newlyStored === false`, i.e. a dedupe boost) incremented
 * it. The sibling `cmd-distill.ts` increments `skipped` on both branches. This understated
 * the CLI's summary output: a candidate that was silently dropped by the pre-store guard
 * didn't count as `stored` OR `skipped`, so `stored + skipped < candidates` with no
 * explanation of where the missing item went.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { runBackfillForCli } from "../cli/cmd-backfill.js";
import type { HandlerContext } from "../cli/handlers.js";

const { FactsDB } = _testing;

let tmpDir: string;
let workspaceRoot: string;
let factsDb: InstanceType<typeof FactsDB>;

function makeSink() {
  return { log: () => {}, warn: () => {} };
}

function makeCtx(): HandlerContext {
  return {
    factsDb,
    vectorDb: {
      hasDuplicate: async () => false,
      store: async () => undefined,
      delete: async () => true,
    },
    embeddings: {
      embed: async () => [0.1, 0.2, 0.3],
      modelName: "test-model",
    },
  } as unknown as HandlerContext;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cmd-backfill-skipped-"));
  workspaceRoot = join(tmpDir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runBackfillForCli — skipped stat on pre-store-guard rejection (loop iteration 79 regression)", () => {
  it("counts a pre-store-guard-blocked candidate as skipped, not silently dropped", async () => {
    writeFileSync(
      join(workspaceRoot, "MEMORY.md"),
      [
        "# memory",
        // Matches the classifier-output marker pattern (isPromptArtifactOrReasoningTrace),
        // so factsDb.storeWithResult() reports { skipped: true } for it.
        "- NOOP | duplicate content flagged during triage",
        "- I prefer dark mode for editors",
      ].join("\n"),
      "utf-8",
    );

    const result = await runBackfillForCli(makeCtx(), { dryRun: false, workspace: workspaceRoot }, makeSink());

    expect(result.candidates).toBe(2);
    expect(result.stored).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.stored + result.skipped).toBe(result.candidates);
  });
});
