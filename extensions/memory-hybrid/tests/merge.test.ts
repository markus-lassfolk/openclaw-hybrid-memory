import { describe, it, expect } from "vitest";
import { _testing } from "../index.js";

const { mergeResults, filterByScope } = _testing;

type SearchResult = Parameters<typeof mergeResults>[0][0];

function makeResult(overrides: Partial<SearchResult["entry"]> & { score?: number; backend?: "sqlite" | "lancedb" }): SearchResult {
  const { score = 0.5, backend = "sqlite", ...entryOverrides } = overrides;
  return {
    entry: {
      id: `id-${Math.random().toString(36).slice(2, 8)}`,
      text: "default text",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
      createdAt: Math.floor(Date.now() / 1000),
      decayClass: "stable",
      expiresAt: null,
      lastConfirmedAt: Math.floor(Date.now() / 1000),
      confidence: 1.0,
      ...entryOverrides,
    },
    score,
    backend,
  };
}

// ---------------------------------------------------------------------------
// mergeResults
// ---------------------------------------------------------------------------

describe("mergeResults", () => {
  it("prioritizes sqlite results over lancedb by default insertion order", () => {
    const sqlite = [makeResult({ text: "sqlite fact", score: 0.9, backend: "sqlite" })];
    const lance = [makeResult({ text: "lance fact", score: 0.8, backend: "lancedb" })];
    const merged = mergeResults(sqlite, lance, 10);
    expect(merged.length).toBe(2);
    expect(merged[0].entry.text).toBe("sqlite fact");
  });

  it("deduplicates by id", () => {
    const sharedId = "shared-id-123";
    const sqlite = [makeResult({ id: sharedId, text: "fact from sqlite", score: 0.9, backend: "sqlite" })];
    const lance = [makeResult({ id: sharedId, text: "fact from lance", score: 0.8, backend: "lancedb" })];
    const merged = mergeResults(sqlite, lance, 10);
    expect(merged.length).toBe(1);
    expect(merged[0].backend).toBe("sqlite");
  });

  it("deduplicates by text (case-insensitive)", () => {
    const sqlite = [makeResult({ text: "User prefers dark mode", score: 0.9, backend: "sqlite" })];
    const lance = [makeResult({ text: "user prefers dark mode", score: 0.7, backend: "lancedb" })];
    const merged = mergeResults(sqlite, lance, 10);
    expect(merged.length).toBe(1);
  });

  it("respects limit", () => {
    const sqlite = [
      makeResult({ text: "fact 1", score: 0.9 }),
      makeResult({ text: "fact 2", score: 0.8 }),
      makeResult({ text: "fact 3", score: 0.7 }),
    ];
    const lance = [
      makeResult({ text: "lance 1", score: 0.6, backend: "lancedb" }),
      makeResult({ text: "lance 2", score: 0.5, backend: "lancedb" }),
    ];
    const merged = mergeResults(sqlite, lance, 3);
    expect(merged.length).toBe(3);
  });

  it("sorts by score descending", () => {
    const sqlite = [makeResult({ text: "low", score: 0.3, backend: "sqlite" })];
    const lance = [makeResult({ text: "high", score: 0.9, backend: "lancedb" })];
    const merged = mergeResults(sqlite, lance, 10);
    expect(merged[0].entry.text).toBe("high");
    expect(merged[1].entry.text).toBe("low");
  });

  it("breaks score ties by sourceDate (newest first)", () => {
    const now = Math.floor(Date.now() / 1000);
    const sqlite = [
      makeResult({ text: "old fact", score: 0.8, createdAt: now - 1000, backend: "sqlite" }),
    ];
    const lance = [
      makeResult({ text: "new fact", score: 0.8, createdAt: now, backend: "lancedb" }),
    ];
    const merged = mergeResults(sqlite, lance, 10);
    expect(merged[0].entry.text).toBe("new fact");
  });

  it("handles empty inputs", () => {
    expect(mergeResults([], [], 10)).toEqual([]);
    const single = [makeResult({ text: "only one", score: 0.5 })];
    expect(mergeResults(single, [], 10).length).toBe(1);
    expect(mergeResults([], single, 10).length).toBe(1);
  });

  it("FR-010: excludes Lance results whose text is superseded", () => {
    const supersededProvider = {
      getSupersededTexts: () => new Set(["old superseded fact"]),
    };
    const sqlite = [makeResult({ text: "Current fact", score: 0.8, backend: "sqlite" })];
    const lance = [
      makeResult({ text: "Old superseded fact", score: 0.9, backend: "lancedb" }),
      makeResult({ text: "Another current fact", score: 0.7, backend: "lancedb" }),
    ];
    const merged = mergeResults(sqlite, lance, 10, supersededProvider);
    expect(merged.length).toBe(2);
    const texts = merged.map((r) => r.entry.text);
    expect(texts).toContain("Current fact");
    expect(texts).toContain("Another current fact");
    expect(texts).not.toContain("Old superseded fact");
  });

  it("uses sourceDate for tie-breaking when available", () => {
    const now = Math.floor(Date.now() / 1000);
    const a = makeResult({ text: "A", score: 0.7, createdAt: now - 5000 });
    (a.entry as Record<string, unknown>).sourceDate = now;
    const b = makeResult({ text: "B", score: 0.7, createdAt: now, backend: "lancedb" });
    const merged = mergeResults([a], [b], 10);
    expect(merged[0].entry.text).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// filterByScope (FR-006)
// ---------------------------------------------------------------------------

describe("filterByScope", () => {
  it("returns all results when scopeFilter is empty", () => {
    const results = [
      makeResult({ text: "A", id: "id-a" }),
      makeResult({ text: "B", id: "id-b" }),
    ];
    const getById = (id: string) => ({ id });
    expect(filterByScope(results, getById, undefined)).toEqual(results);
    expect(filterByScope(results, getById, {})).toEqual(results);
  });

  it("filters out results not in scope", () => {
    const inScope = makeResult({ text: "In scope", id: "id-1" });
    const outOfScope = makeResult({ text: "Out of scope", id: "id-2" });
    const results = [inScope, outOfScope];
    const getById = (id: string, opts?: { scopeFilter?: { userId?: string } }) => {
      if (id === "id-2" && opts?.scopeFilter?.userId === "alice") return null;
      return { id };
    };
    const filtered = filterByScope(results, getById, { userId: "alice" });
    expect(filtered.length).toBe(1);
    expect(filtered[0].entry.id).toBe("id-1");
  });
});
