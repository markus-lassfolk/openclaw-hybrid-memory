import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { executeMineCommand } from "../cli/cmd-mine.js";

const { FactsDB } = _testing;

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;
let transcriptPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cmd-mine-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  transcriptPath = join(tmpDir, "transcript.txt");
  writeFileSync(transcriptPath, "User: hello there\nAssistant: hi, how can I help?", "utf-8");
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("executeMineCommand scope", () => {
  it("defaults to global scope when --scope is not provided", async () => {
    await executeMineCommand(transcriptPath, { source: "text" }, factsDb);
    const rows = factsDb
      .getRawDb()
      .prepare("SELECT scope, scope_target FROM facts WHERE source LIKE 'mine:%'")
      .all() as Array<{ scope: string; scope_target: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("global");
    expect(rows[0].scope_target).toBeNull();
  });

  it("stores facts under the requested non-global scope instead of always global", async () => {
    await executeMineCommand(
      transcriptPath,
      { source: "text", scope: "user", scopeTarget: "user-42" },
      factsDb,
    );
    const rows = factsDb
      .getRawDb()
      .prepare("SELECT scope, scope_target FROM facts WHERE source LIKE 'mine:%'")
      .all() as Array<{ scope: string; scope_target: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("user");
    expect(rows[0].scope_target).toBe("user-42");
  });
});

describe("executeMineCommand embed ordering", () => {
  it("does not mark a fact as embedded when vectorDb.store fails", async () => {
    const vectorDb = {
      store: async () => {
        throw new Error("lance disk full");
      },
      delete: async () => true,
    };
    const embeddings = { embed: async () => [0.1, 0.2, 0.3], modelName: "test-model" };

    const warnSpy = console.warn;
    console.warn = () => {};
    try {
      await executeMineCommand(transcriptPath, { source: "text", embed: true }, factsDb, vectorDb, embeddings);
    } finally {
      console.warn = warnSpy;
    }

    const row = factsDb
      .getRawDb()
      .prepare("SELECT embedding_model FROM facts WHERE source LIKE 'mine:%'")
      .get() as { embedding_model: string | null } | undefined;
    expect(row?.embedding_model ?? null).toBeNull();
  });

  it("marks a fact as embedded only after vectorDb.store succeeds", async () => {
    const stored: string[] = [];
    const vectorDb = {
      store: async (entry: { id: string }) => {
        stored.push(entry.id);
        return undefined;
      },
      delete: async () => true,
    };
    const embeddings = { embed: async () => [0.1, 0.2, 0.3], modelName: "test-model" };

    await executeMineCommand(transcriptPath, { source: "text", embed: true }, factsDb, vectorDb, embeddings);

    const row = factsDb
      .getRawDb()
      .prepare("SELECT id, embedding_model FROM facts WHERE source LIKE 'mine:%'")
      .get() as { id: string; embedding_model: string | null } | undefined;
    expect(row?.embedding_model).toBe("test-model");
    expect(stored).toEqual([row?.id]);
  });
});
