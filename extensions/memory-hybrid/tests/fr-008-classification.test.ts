/**
 * FR-008: ADD/UPDATE/DELETE/NOOP classification.
 * Tests findSimilarByEmbedding (embedding-based similar-fact retrieval for classification).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";
import { vectorDimsForModel } from "../config.js";

const { FactsDB, VectorDB, findSimilarByEmbedding } = _testing;

const VECTOR_DIM = vectorDimsForModel("text-embedding-3-small");

describe("FR-008 findSimilarByEmbedding", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let vectorDb: InstanceType<typeof VectorDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fr008-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vectorDb = new VectorDB(join(tmpDir, "lance"), VECTOR_DIM);
  });

  afterEach(() => {
    factsDb.close();
    vectorDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns facts resolved from vector search ids and filters superseded", async () => {
    const entry = factsDb.store({
      text: "User prefers VS Code with dark mode",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "editor",
      value: "VS Code dark",
      source: "conversation",
    });

    const vector = new Array(VECTOR_DIM).fill(0.01);
    vector[0] = 0.5;
    await vectorDb.store({
      text: entry.text,
      vector,
      importance: 0.8,
      category: "preference",
      id: entry.id,
    });

    const similar = await findSimilarByEmbedding(vectorDb, factsDb, vector, 5);
    expect(similar).toHaveLength(1);
    expect(similar[0].id).toBe(entry.id);
    expect(similar[0].text).toBe("User prefers VS Code with dark mode");

    factsDb.supersede(entry.id, null);
    const afterSupersede = await findSimilarByEmbedding(vectorDb, factsDb, vector, 5);
    expect(afterSupersede).toHaveLength(0);
  });

  it("returns empty when vector search finds no rows", async () => {
    const vector = new Array(VECTOR_DIM).fill(0.1);
    const similar = await findSimilarByEmbedding(vectorDb, factsDb, vector, 3);
    expect(similar).toHaveLength(0);
  });

  it("respects minScore and limit", async () => {
    const entry = factsDb.store({
      text: "One fact",
      category: "other",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const v = new Array(VECTOR_DIM).fill(0);
    v[0] = 1;
    await vectorDb.store({ text: entry.text, vector: v, importance: 0.7, category: "other", id: entry.id });

    const similar = await findSimilarByEmbedding(vectorDb, factsDb, v, 1, 0.3);
    expect(similar.length).toBeLessThanOrEqual(1);
  });
});
