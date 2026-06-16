/**
 * Fragment recall UX tests (#1914).
 */

import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../types/memory.js";
import {
  applyFragmentRecallPostProcess,
  formatFragmentRecallText,
  preferFragmentsOverParents,
  resolveFragmentParentId,
} from "../services/fragment-recall.js";

function entry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, "id" | "text">): MemoryEntry {
  return {
    category: "fact",
    importance: 0.5,
    entity: null,
    key: null,
    value: null,
    source: "conversation",
    createdAt: 1,
    decayClass: "stable",
    expiresAt: null,
    lastConfirmedAt: 1,
    confidence: 1,
    ...partial,
  };
}

describe("fragment recall (#1914)", () => {
  it("resolves parent id from source or column", () => {
    expect(resolveFragmentParentId(entry({ id: "c1", text: "chunk", source: "fragment-of:parent-1" }))).toBe(
      "parent-1",
    );
    expect(resolveFragmentParentId(entry({ id: "c2", text: "chunk", parentFactId: "parent-2" }))).toBe("parent-2");
  });

  it("prefers fragment children over parent facts", () => {
    const parent = entry({ id: "parent", text: "Long parent document" });
    const child = entry({
      id: "child",
      text: "specific chunk",
      source: "fragment-of:parent",
      tags: ["fragment"],
    });
    const results = preferFragmentsOverParents([
      { entry: parent, score: 0.95, backend: "sqlite" },
      { entry: child, score: 0.8, backend: "vector" },
    ]);
    expect(results.map((r) => r.entry.id)).toEqual(["child"]);
  });

  it("hydrates parent context in injection text", () => {
    const parent = entry({ id: "parent", text: "Parent doc body", summary: "Parent summary" });
    const child = entry({ id: "child", text: "chunk text", source: "fragment-of:parent", tags: ["fragment"] });
    const text = formatFragmentRecallText(child, parent, false);
    expect(text).toContain("[§ Parent summary]");
    expect(text).toContain("chunk text");
  });

  it("boosts fragment scores in post-process", () => {
    const parent = entry({ id: "parent", text: "parent" });
    const child = entry({ id: "child", text: "child", source: "fragment-of:parent", tags: ["fragment"] });
    const out = applyFragmentRecallPostProcess(
      [
        { entry: parent, score: 0.9, backend: "sqlite" },
        { entry: child, score: 0.86, backend: "vector" },
      ],
      { fragmentScoreBoost: 1.1 },
    );
    expect(out[0].entry.id).toBe("child");
    expect(out[0].score).toBeGreaterThan(0.86);
  });
});
