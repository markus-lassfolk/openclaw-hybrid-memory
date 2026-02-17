/**
 * FR-008: ADD/UPDATE/DELETE/NOOP classification.
 * Tests parseClassificationResponse (LLM response parser) and findSimilarByEmbedding (embedding-based similar-fact retrieval).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";
import { vectorDimsForModel } from "../config.js";
import type { MemoryEntry } from "../types/memory.js";

const { FactsDB, VectorDB, findSimilarByEmbedding, parseClassificationResponse } = _testing;

function mockFact(id: string, text: string): MemoryEntry {
  return {
    id,
    text,
    category: "preference",
    importance: 0.8,
    entity: "user",
    key: "editor",
    value: "value",
    source: "test",
    createdAt: Math.floor(Date.now() / 1000),
    decayClass: "stable",
    expiresAt: null,
    lastConfirmedAt: Math.floor(Date.now() / 1000),
    confidence: 1,
  };
}

const VECTOR_DIM = vectorDimsForModel("text-embedding-3-small");

describe("FR-008 parseClassificationResponse", () => {
  const existingFacts: MemoryEntry[] = [
    mockFact("550e8400-e29b-41d4-a716-446655440000", "User prefers VS Code with dark mode"),
    mockFact("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "User uses Linux"),
  ];

  it("parses ADD with reason", () => {
    const r = parseClassificationResponse("ADD | this is new information about the user's work setup", existingFacts);
    expect(r.action).toBe("ADD");
    expect(r.targetId).toBeUndefined();
    expect(r.reason).toBe("this is new information about the user's work setup");
  });

  it("parses NOOP with reason", () => {
    const r = parseClassificationResponse("NOOP | this preference is already stored as fact #2", existingFacts);
    expect(r.action).toBe("NOOP");
    expect(r.targetId).toBeUndefined();
    expect(r.reason).toContain("already stored");
  });

  it("parses UPDATE with valid target id and reason", () => {
    const id = existingFacts[0].id;
    const r = parseClassificationResponse(`UPDATE ${id} | user changed their preferred IDE from VS Code to Cursor`, existingFacts);
    expect(r.action).toBe("UPDATE");
    expect(r.targetId).toBe(id);
    expect(r.reason).toContain("Cursor");
  });

  it("parses DELETE with valid target id and reason", () => {
    const id = existingFacts[1].id;
    const r = parseClassificationResponse(`DELETE ${id} | user explicitly stated they no longer use Docker`, existingFacts);
    expect(r.action).toBe("DELETE");
    expect(r.targetId).toBe(id);
    expect(r.reason).toContain("no longer");
  });

  it("falls back to ADD when response is unparseable", () => {
    const r = parseClassificationResponse("I think we should add this", existingFacts);
    expect(r.action).toBe("ADD");
    expect(r.reason).toContain("unparseable");
  });

  it("falls back to ADD when UPDATE has missing target id", () => {
    const r = parseClassificationResponse("UPDATE  | user changed preference", existingFacts);
    expect(r.action).toBe("ADD");
    expect(r.reason).toContain("missing targetId");
  });

  it("falls back to ADD when UPDATE references unknown id", () => {
    const r = parseClassificationResponse("UPDATE 00000000-0000-0000-0000-000000000000 | user changed", existingFacts);
    expect(r.action).toBe("ADD");
    expect(r.reason).toContain("unknown id");
  });

  it("falls back to ADD when DELETE references unknown id", () => {
    const r = parseClassificationResponse("DELETE 00000000-0000-0000-0000-000000000000 | retracted", existingFacts);
    expect(r.action).toBe("ADD");
    expect(r.reason).toContain("unknown id");
  });

  it("is case-insensitive for action", () => {
    const r = parseClassificationResponse("add | new fact", existingFacts);
    expect(r.action).toBe("ADD");
  });
});

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
