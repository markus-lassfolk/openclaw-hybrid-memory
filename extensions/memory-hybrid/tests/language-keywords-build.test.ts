import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectSamplesFromFacts,
  runBuildLanguageKeywords,
} from "../services/language-keywords-build.js";
import { setKeywordsPath, clearKeywordCache } from "../utils/language-keywords.js";

describe("language-keywords-build", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lang-kw-build-test-"));
    clearKeywordCache();
    setKeywordsPath("");
  });

  afterEach(() => {
    clearKeywordCache();
    setKeywordsPath("");
    try {
      if (tmpDir) rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  describe("collectSamplesFromFacts", () => {
    it("returns empty array when no facts", () => {
      expect(collectSamplesFromFacts([])).toEqual([]);
    });

    it("skips facts with very short text", () => {
      expect(collectSamplesFromFacts([{ text: "short" }])).toEqual([]);
    });

    it("returns samples when facts have enough text", () => {
      const facts = [{ text: "This is a long enough fact to be sampled for language detection." }];
      const out = collectSamplesFromFacts(facts);
      expect(out.length).toBe(1);
      expect(out[0].length).toBeGreaterThan(20);
    });

    it("caps each sample at charsPerSample", () => {
      const long = "a".repeat(1000);
      const facts = [{ text: long }];
      const out = collectSamplesFromFacts(facts, 10, 100);
      expect(out[0].length).toBe(100);
    });

    it("respects maxSamples", () => {
      const facts = Array.from({ length: 100 }, (_, i) => ({
        text: `Unique fact number ${i} with enough text to be included in the sample set.`,
      }));
      const out = collectSamplesFromFacts(facts, 5, 400);
      expect(out.length).toBe(5);
    });

    it("deduplicates by first 80 chars", () => {
      const prefix = "A".repeat(80);
      const facts = [
        { text: prefix + " suffix one" },
        { text: prefix + " suffix two" },
      ];
      const out = collectSamplesFromFacts(facts, 10, 400);
      expect(out.length).toBe(1);
    });
  });

  describe("runBuildLanguageKeywords", () => {
    it("writes .language-keywords.json when LLM returns languages and translations", async () => {
      const mockOpenai = {
        chat: {
          completions: {
            create: async (opts: { model: string; messages: unknown[] }) => {
              const content = opts.messages?.[0];
              const msg = typeof content === "object" && content && "content" in content ? String((content as { content: string }).content) : "";
              if (msg.includes("language detector")) {
                return { choices: [{ message: { content: '["sv","de"]' } }] };
              }
              return {
                choices: [{
                  message: {
                    content: JSON.stringify({
                      sv: {
                        triggers: ["kom ihåg", "föredrar"],
                        categoryDecision: ["bestämde"],
                        categoryPreference: ["föredrar"],
                        categoryEntity: ["heter"],
                        categoryFact: ["född"],
                        decayPermanent: ["bestämde"],
                        decaySession: ["just nu"],
                        decayActive: ["behöver"],
                        correctionSignals: ["du missförstod"],
                        triggerStructures: ["jag föredrar"],
                        extraction: {},
                      },
                      de: {
                        triggers: ["merken", "bevorzuge"],
                        categoryDecision: ["entschieden"],
                        categoryPreference: ["bevorzuge"],
                        categoryEntity: ["heißen"],
                        categoryFact: ["geboren"],
                        decayPermanent: ["entschieden"],
                        decaySession: ["gerade jetzt"],
                        decayActive: ["brauchen"],
                        correctionSignals: ["du hast falsch verstanden"],
                        triggerStructures: ["ich bevorzuge"],
                        extraction: {},
                      },
                    }),
                  },
                }],
              };
            },
          },
        },
      } as any;

      const facts = [
        { text: "Jag föredrar att använda svenska när jag pratar med Lotta." },
        { text: "We decided to use TypeScript for the project." },
      ];
      const result = await runBuildLanguageKeywords(
        facts,
        mockOpenai,
        tmpDir,
        { model: "gpt-4o-mini", dryRun: false },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.path).toBe(join(tmpDir, ".language-keywords.json"));
      expect(result.languagesAdded).toBe(2);
      expect(result.topLanguages).toContain("sv");
      expect(result.topLanguages).toContain("de");

      const filePath = join(tmpDir, ".language-keywords.json");
      expect(existsSync(filePath)).toBe(true);
      const data = JSON.parse(readFileSync(filePath, "utf8"));
      expect(data.version).toBe(2);
      expect(data.topLanguages).toEqual(expect.arrayContaining(["sv", "de"]));
      expect(data.translations.sv).toBeDefined();
      expect(data.translations.sv.triggers).toContain("föredrar");
      expect(data.translations.de).toBeDefined();
    });

    it("dryRun does not write file", async () => {
      const mockOpenai = {
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: '["sv"]' } }],
            }),
          },
        },
      } as any;
      const facts = [{ text: "Ett tillräckligt långt faktum på svenska för att detektera språk." }];
      const result = await runBuildLanguageKeywords(
        facts,
        mockOpenai,
        tmpDir,
        { model: "gpt-4o-mini", dryRun: true },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(existsSync(join(tmpDir, ".language-keywords.json"))).toBe(false);
    });

    it("returns ok with path and zero languages when no samples", async () => {
      const mockOpenai = { chat: { completions: { create: async () => ({ choices: [] }) } } } as any;
      const result = await runBuildLanguageKeywords(
        [],
        mockOpenai,
        tmpDir,
        { model: "gpt-4o-mini", dryRun: false },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.path).toBe(join(tmpDir, ".language-keywords.json"));
    });
  });
});
