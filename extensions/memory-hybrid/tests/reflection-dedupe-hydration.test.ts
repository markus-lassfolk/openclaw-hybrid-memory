import { describe, expect, it } from "vitest";
import {
  computeDedupeCorpusFingerprint,
  reflectionLexicalNearDuplicateAgainstFact,
  resolveReflectionDedupeHydration,
} from "../services/reflection-dedupe-hydration.js";

describe("resolveReflectionDedupeHydration", () => {
  it("applies defaults when partial is null", () => {
    const r = resolveReflectionDedupeHydration(null);
    expect(r.maxEmbedsPerRun).toBeGreaterThan(0);
    expect(r.minIntervalMsBetweenEmbeds).toBeGreaterThan(0);
  });

  it("honors maxEmbedsPerRun 0 as unlimited", () => {
    const r = resolveReflectionDedupeHydration({ maxEmbedsPerRun: 0 });
    expect(r.maxEmbedsPerRun).toBe(0);
  });
});

describe("computeDedupeCorpusFingerprint", () => {
  it("changes when id set changes", () => {
    const a = computeDedupeCorpusFingerprint(["b", "a"], "m1");
    const b = computeDedupeCorpusFingerprint(["a", "b", "c"], "m1");
    expect(a).not.toBe(b);
  });

  it("is stable for same sorted ids and model", () => {
    const fp1 = computeDedupeCorpusFingerprint(["x", "y"], "m");
    const fp2 = computeDedupeCorpusFingerprint(["x", "y"], "m");
    expect(fp1).toBe(fp2);
  });
});

describe("reflectionLexicalNearDuplicateAgainstFact", () => {
  it("detects normalized equality", () => {
    expect(reflectionLexicalNearDuplicateAgainstFact("User prefers TypeScript", "user  prefers   typescript")).toBe(
      true,
    );
  });

  it("detects high token overlap when threshold is relaxed", () => {
    const a = "The user consistently values small focused functions under twenty lines";
    const b = "User values small focused functions under twenty lines for readability";
    expect(reflectionLexicalNearDuplicateAgainstFact(a, b, 0.65)).toBe(true);
  });

  it("returns false for unrelated short strings", () => {
    expect(reflectionLexicalNearDuplicateAgainstFact("alpha beta gamma delta", "one two three four five")).toBe(false);
  });
});
