vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: vi.fn(),
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AliasDB } from "../services/retrieval-aliases.js";
import * as errorReporter from "../services/error-reporter.js";

function unitVec(dims = 4): number[] {
  const vector = new Array(dims).fill(0);
  vector[0] = 1;
  return vector;
}

describe("AliasDB LanceDB schema mismatch fallback", () => {
  let tmpDir: string;
  let aliasDb: AliasDB | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alias-schema-test-"));
    aliasDb = undefined;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    aliasDb?.close();
    // Allow pending LanceDB write transactions to flush before cleanup
    await new Promise((r) => setTimeout(r, 250));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to linear search without reporting GlitchTip on known alias vector schema errors", async () => {
    aliasDb = new AliasDB(join(tmpDir, "aliases.db"), join(tmpDir, "aliases.lance"), 4);

    for (let index = 0; index < 1000; index++) {
      aliasDb.store(randomUUID(), `alias-${index}`, unitVec());
    }

    const knownSchemaErr = new Error(
      "Failed to execute query stream: GenericFailure, Invalid input, No vector column found to match with the query vector dimension",
    );

    const aliasIndex = (aliasDb as any).aliasIndex;
    await aliasIndex.search(unitVec(), 5, 0.1);
    aliasIndex.table = {
      vectorSearch: () => {
        throw knownSchemaErr;
      },
    };

    const results = await aliasDb.search(unitVec(), 5, 0.1);

    expect(results).toHaveLength(5);
    expect(results.every((result: { score: number }) => result.score > 0.9)).toBe(true);
    expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
  });
});
