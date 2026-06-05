import { describe, expect, it } from "vitest";
import {
  isCredentialFact,
  isInternalWikiArtifact,
  isWikiExportableFact,
  wikiFactKind,
  wikiFactTitle,
} from "../services/wiki-fact-filter.js";
import type { MemoryEntry } from "../types/memory.js";

function makeFact(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "fact-1",
    text: "Sample fact text",
    category: "general",
    importance: 0.5,
    entity: null,
    key: null,
    value: null,
    source: "conversation",
    createdAt: 1717200000,
    decayClass: "stable",
    expiresAt: null,
    lastConfirmedAt: 1717200000,
    confidence: 0.8,
    ...overrides,
  };
}

describe("wiki-fact-filter", () => {
  it("detects credential facts", () => {
    expect(isCredentialFact(makeFact({ category: "credential" }))).toBe(true);
    expect(isCredentialFact(makeFact({ entity: "Credentials" }))).toBe(true);
    expect(isCredentialFact(makeFact())).toBe(false);
  });

  it("detects internal sentinel artifacts", () => {
    expect(
      isInternalWikiArtifact(
        makeFact({ entity: "system", key: "dream-ingested-run:abc", tags: ["dream-ingester-sentinel"] }),
      ),
    ).toBe(true);
    expect(isInternalWikiArtifact(makeFact())).toBe(false);
  });

  it("combines export eligibility checks", () => {
    expect(isWikiExportableFact(makeFact())).toBe(true);
    expect(isWikiExportableFact(makeFact({ category: "credential" }))).toBe(false);
  });

  it("formats wiki titles and kinds", () => {
    const fact = makeFact({ entity: "React", key: "hooks", source: "dream-cycle:run-1" });
    expect(wikiFactTitle(fact)).toBe("React / hooks");
    expect(wikiFactKind(fact)).toBe("dream-report");
  });
});
