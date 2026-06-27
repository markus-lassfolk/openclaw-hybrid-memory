import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { hybridConfigSchema } from "../config.js";
import { loadActiveTasksForTools } from "../services/active-task-tools-loader.js";
import { upsertProjectTaskKey } from "../services/task-ledger-facts.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { VectorDB } from "../backends/vector-db.js";

describe("loadActiveTasksForTools", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads facts-ledger tasks without throwing (regression: destructuring active array)", async () => {
    const root = mkdtempSync(join(tmpdir(), "hm-tools-loader-"));
    dirs.push(root);
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      sqlitePath: join(root, "facts.db"),
      lanceDbPath: join(root, "lancedb"),
      activeTask: { enabled: true, ledger: "facts", filePath: "ACTIVE-TASKS.md" },
    });
    const factsDb = new FactsDB(join(root, "facts.db"));
    const vectorDb = { hasDuplicate: vi.fn().mockResolvedValue(true), store: vi.fn() } as unknown as VectorDB;
    const embeddings = {
      modelName: "text-embedding-3-small",
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
      embedBatch: vi.fn(),
    } as EmbeddingProvider;

    await upsertProjectTaskKey(factsDb, vectorDb, embeddings, "deploy-prod", "status", "in_progress");
    await upsertProjectTaskKey(factsDb, vectorDb, embeddings, "deploy-prod", "title", "Deploy production");

    const loaded = await loadActiveTasksForTools(cfg, join(root, "ACTIVE-TASKS.md"), factsDb);
    expect(loaded?.source).toBe("facts");
    expect(loaded?.tasks).toHaveLength(1);
    expect(loaded?.tasks[0]?.label).toBe("deploy-prod");
  });
});
