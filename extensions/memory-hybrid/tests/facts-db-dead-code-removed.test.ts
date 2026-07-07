/**
 * loop iteration 99 regression: getDuplicateIdByNormalizedHash was confirmed dead code (no
 * caller anywhere in the codebase besides its own public FactsDB re-export) with an unscoped
 * SQL lookup unlike its scoped siblings in services/dedupe-policy.ts. Rather than adding a scope
 * filter to code nothing calls, it was removed entirely -- this asserts it stays removed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";

describe("FactsDB.getDuplicateIdByNormalizedHash removal (loop iteration 99 regression)", () => {
  let tmpDir: string;
  let db: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "facts-db-dead-code-"));
    db = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is no longer a method on FactsDB instances", () => {
    expect((db as unknown as Record<string, unknown>).getDuplicateIdByNormalizedHash).toBeUndefined();
  });
});
