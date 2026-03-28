/**
 * Reflection layer — parsePatternsFromReflectionResponse and prompt loading.
 */

import { describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { getCurrentCostFeature } from "../services/cost-context.js";
import { runReflection, runReflectionMeta, runReflectionRules } from "../services/reflection.js";
import type { MemoryEntry } from "../types/memory.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";

const { parsePatternsFromReflectionResponse } = _testing;

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "fact-1",
    text: overrides.text ?? "User prefers TypeScript over JavaScript for type safety",
    category: overrides.category ?? "preference",
    importance: overrides.importance ?? 0.7,
    entity: overrides.entity ?? null,
    key: overrides.key ?? null,
    value: overrides.value ?? null,
    source: overrides.source ?? "test",
    createdAt: overrides.createdAt ?? Date.now(),
    decayClass: overrides.decayClass ?? "stable",
    expiresAt: overrides.expiresAt ?? null,
    lastConfirmedAt: overrides.lastConfirmedAt ?? Date.now(),
    confidence: overrides.confidence ?? 0.7,
    ...overrides,
  };
}

describe("parsePatternsFromReflectionResponse", () => {
  it("extracts valid PATTERN: lines", () => {
    const raw = `
Some intro text.

PATTERN: User consistently favors functional composition over OOP
PATTERN: User prefers small, focused code units (functions <20 lines)
PATTERN: User values type safety (TypeScript strict mode)

Other content ignored.
`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toBe("User consistently favors functional composition over OOP");
    expect(parsed[1]).toBe("User prefers small, focused code units (functions <20 lines)");
    expect(parsed[2]).toBe("User values type safety (TypeScript strict mode)");
  });

  it("ignores lines that are too short (<20 chars)", () => {
    const raw = "PATTERN: Too short";
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(0);
  });

  it("ignores lines that are too long (>500 chars)", () => {
    const long = "x".repeat(501);
    const raw = `PATTERN: ${long}`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(0);
  });

  it("accepts patterns at exact min/max bounds", () => {
    const minLen = "x".repeat(20);
    const maxLen = "x".repeat(500);
    const raw = `PATTERN: ${minLen}\nPATTERN: ${maxLen}`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(2);
  });

  it("deduplicates case-insensitive within batch", () => {
    const raw = `
PATTERN: User prefers composition over inheritance
PATTERN: user prefers composition over inheritance
PATTERN: User prefers composition over inheritance
`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe("User prefers composition over inheritance");
  });

  it("handles leading whitespace before PATTERN:", () => {
    const raw = "  PATTERN: User prefers explicit error handling";
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe("User prefers explicit error handling");
  });

  it("returns empty for empty or non-matching input", () => {
    expect(parsePatternsFromReflectionResponse("")).toHaveLength(0);
    expect(parsePatternsFromReflectionResponse("No PATTERN: here")).toHaveLength(0);
    expect(parsePatternsFromReflectionResponse("RULE: This is a rule")).toHaveLength(0);
  });
});

describe("runReflection cost attribution", () => {
  it("LLM call is attributed to 'reflection' feature", async () => {
    let capturedFeature: string | undefined;
    const fact = makeEntry();
    const factsDb = {
      getRecentFacts: () => [fact],
      store: async () => ({ id: "pattern-1", text: fact.text, category: "pattern" }) as MemoryEntry,
      setEmbeddingModel: () => undefined,
    };
    const vectorDb = { store: async () => undefined };
    const embeddings = { embed: async () => [1, 0], modelName: "test-model" };
    const openai = {
      chat: {
        completions: {
          create: async () => {
            capturedFeature = getCurrentCostFeature();
            return { choices: [{ message: { content: "No patterns detected in the provided facts." } }] };
          },
        },
      },
    };

    await runReflection(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { defaultWindow: 14, minObservations: 1, enabled: true },
      { window: 7, dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(capturedFeature).toBe("reflection");
  });
});

describe("runReflectionRules cost attribution", () => {
  it("LLM call is attributed to 'reflection-rules' feature", async () => {
    let capturedFeature: string | undefined;
    const pattern1 = makeEntry({
      id: "p1",
      category: "pattern",
      text: "User consistently prefers functional composition over object-oriented patterns",
    });
    const pattern2 = makeEntry({
      id: "p2",
      category: "pattern",
      text: "User values type safety and always enables TypeScript strict mode in projects",
    });
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? [pattern1, pattern2] : []),
      store: async () => ({ id: "rule-1", text: "Always use functional patterns", category: "rule" }) as MemoryEntry,
      setEmbeddingModel: () => undefined,
    };
    const vectorDb = { store: async () => undefined };
    const embeddings = { embed: async () => [1, 0], modelName: "test-model" };
    const openai = {
      chat: {
        completions: {
          create: async () => {
            capturedFeature = getCurrentCostFeature();
            return { choices: [{ message: { content: "No rules detected." } }] };
          },
        },
      },
    };

    await runReflectionRules(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(capturedFeature).toBe("reflection-rules");
  });
});

describe("runReflectionMeta cost attribution", () => {
  it("LLM call is attributed to 'reflection-meta' feature", async () => {
    let capturedFeature: string | undefined;
    const pattern1 = makeEntry({
      id: "p1",
      category: "pattern",
      text: "User consistently prefers functional composition over object-oriented patterns",
    });
    const pattern2 = makeEntry({
      id: "p2",
      category: "pattern",
      text: "User values type safety and always enables TypeScript strict mode in projects",
    });
    const pattern3 = makeEntry({
      id: "p3",
      category: "pattern",
      text: "User prefers small focused functions under twenty lines with clear single responsibility",
    });
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? [pattern1, pattern2, pattern3] : []),
      store: async () => ({ id: "meta-1", text: "Core meta-pattern", category: "pattern" }) as MemoryEntry,
      setEmbeddingModel: () => undefined,
    };
    const vectorDb = { store: async () => undefined };
    const embeddings = { embed: async () => [1, 0], modelName: "test-model" };
    const openai = {
      chat: {
        completions: {
          create: async () => {
            capturedFeature = getCurrentCostFeature();
            return { choices: [{ message: { content: "No meta-patterns detected." } }] };
          },
        },
      },
    };

    await runReflectionMeta(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(capturedFeature).toBe("reflection-meta");
  });
});

describe("Reflection prompt template", () => {
  it("loads reflection prompt with window and facts placeholders", () => {
    const tmpl = loadPrompt("reflection");
    expect(tmpl).toContain("{{window}}");
    expect(tmpl).toContain("{{facts}}");
  });

  it("fillPrompt substitutes window and facts", () => {
    const tmpl = loadPrompt("reflection");
    const filled = fillPrompt(tmpl, { window: "14", facts: "[preference] User likes dark mode" });
    expect(filled).toContain("14");
    expect(filled).toContain("[preference] User likes dark mode");
  });
});
