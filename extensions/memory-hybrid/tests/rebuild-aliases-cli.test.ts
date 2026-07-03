import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AliasDB } from "../services/retrieval-aliases.js";
import { hybridConfigSchema } from "../config.js";

function unitVec(dims = 4): number[] {
  const vector = new Array(dims).fill(0);
  vector[0] = 1;
  return vector;
}

describe("AliasDB rebuildLanceFromSqlite", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alias-rebuild-"));
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 100));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rebuilds Lance table from SQLite embeddings", async () => {
    const factA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const factB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const aliasDb = new AliasDB(join(tmpDir, "aliases.db"), join(tmpDir, "aliases.lance"), 4);
    aliasDb.store(factA, "alias one", unitVec());
    aliasDb.store(factB, "alias two", unitVec());
    await new Promise((r) => setTimeout(r, 500));

    const result = await aliasDb.rebuildLanceFromSqlite({
      embed: async () => unitVec(),
      modelName: "test",
    } as never);

    expect(result.stored).toBe(2);
    const diag = await aliasDb.getLanceDiagnostics();
    expect(diag.schemaValid).toBe(true);
    expect(diag.lanceDim).toBe(4);
    aliasDb.close();
  });
});

describe("storage rebuild-aliases config gate", () => {
  it("aliases feature can be enabled in config schema", () => {
    const cfg = hybridConfigSchema.parse({
      mode: "local",
      verbosity: "normal",
      aliases: { enabled: true, maxAliases: 3 },
      embedding: { provider: "ollama", model: "nomic-embed-text", dimensions: 4 },
    });
    expect(cfg.aliases.enabled).toBe(true);
  });
});
