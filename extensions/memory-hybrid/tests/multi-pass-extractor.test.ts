/**
 * Tests for Issue #166 — Multi-Pass Extraction with Verification.
 *
 * Coverage:
 *   buildPass1Prompt / buildPass2Prompt / buildVerificationPrompt:
 *     - includes transcript content in prompts
 *   parseCandidateFacts:
 *     - parses valid JSON array
 *     - handles markdown code fences
 *     - returns [] for invalid JSON
 *     - returns [] for non-array JSON
 *     - skips items with no text field
 *     - defaults category to "other" when missing
 *     - defaults importance to 0.7 when out-of-range
 *     - assigns the correct pass number
 *   parseVerdict:
 *     - returns CONFIRMED, REJECTED, UNCERTAIN
 *     - case-insensitive
 *     - defaults to UNCERTAIN for unrecognised
 *     - CONFIRMED beats REJECTED when both present
 *   MultiPassExtractor.runPass1:
 *     - returns parsed candidates on success
 *     - returns [] on LLM error
 *   MultiPassExtractor.runPass2:
 *     - returns parsed candidates on success
 *     - returns [] when LLM throws
 *   MultiPassExtractor.verifyCandidate:
 *     - returns CONFIRMED / REJECTED / UNCERTAIN
 *     - returns UNCERTAIN on LLM error
 *   MultiPassExtractor.extract — no verification:
 *     - extracts from Pass 1 + Pass 2 and treats all as CONFIRMED
 *     - extractionPasses=false skips Pass 2
 *     - LLM errors in Pass 1 return empty fact list
 *   MultiPassExtractor.extract — with verification:
 *     - CONFIRMED facts retain confidence
 *     - UNCERTAIN facts get confidence 0.4 and "needs-review" tag
 *     - REJECTED facts are excluded from output
 *     - rejectedCount reflects excluded facts
 *   extractMultiPass convenience function:
 *     - delegates to MultiPassExtractor
 *   ExtractionConfig parsing:
 *     - defaults to extractionPasses=false, verificationPass=false
 *     - parses all fields correctly
 *     - ignores empty string model names
 */

import { describe, it, expect, vi } from "vitest";
import {
  MultiPassExtractor,
  extractMultiPass,
  buildPass1Prompt,
  buildPass2Prompt,
  buildVerificationPrompt,
  parseCandidateFacts,
  parseVerdict,
  type CandidateFact,
} from "../services/multi-pass-extractor.js";
import { hybridConfigSchema } from "../config.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeOpenAI(responses: Array<string | Error>) {
  const queue = [...responses];
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async () => {
          const next = queue.shift();
          if (next instanceof Error) throw next;
          return { choices: [{ message: { content: next ?? "" } }] };
        }),
      },
    },
  };
}

const TRANSCRIPT = "user: I prefer TypeScript over JavaScript.\nassistant: Got it.";

const CANDIDATE: CandidateFact = {
  text: "I prefer TypeScript over JavaScript",
  category: "preferences",
  importance: 0.8,
  pass: 1,
};

const BASE_CONFIG = {
  embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
};

// ---------------------------------------------------------------------------
// 1. Prompt builders
// ---------------------------------------------------------------------------

describe("buildPass1Prompt", () => {
  it("includes the transcript in the prompt", () => {
    const prompt = buildPass1Prompt(TRANSCRIPT);
    expect(prompt).toContain(TRANSCRIPT);
  });
});

describe("buildPass2Prompt", () => {
  it("includes the transcript in the prompt", () => {
    const prompt = buildPass2Prompt(TRANSCRIPT);
    expect(prompt).toContain(TRANSCRIPT);
  });
});

describe("buildVerificationPrompt", () => {
  it("includes the fact text in the prompt", () => {
    const prompt = buildVerificationPrompt(CANDIDATE, TRANSCRIPT);
    expect(prompt).toContain(CANDIDATE.text);
  });

  it("includes the transcript in the prompt", () => {
    const prompt = buildVerificationPrompt(CANDIDATE, TRANSCRIPT);
    expect(prompt).toContain(TRANSCRIPT);
  });
});

// ---------------------------------------------------------------------------
// 2. parseCandidateFacts
// ---------------------------------------------------------------------------

describe("parseCandidateFacts", () => {
  it("parses a valid JSON array", () => {
    const json = JSON.stringify([{ text: "Fact A", category: "preferences", importance: 0.8 }]);
    const facts = parseCandidateFacts(json, 1);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe("Fact A");
    expect(facts[0].category).toBe("preference");
    expect(facts[0].importance).toBe(0.8);
    expect(facts[0].pass).toBe(1);
  });

  it("handles markdown code fences", () => {
    const json = "```json\n" + JSON.stringify([{ text: "Fact B", category: "other", importance: 0.5 }]) + "\n```";
    const facts = parseCandidateFacts(json, 2);
    expect(facts).toHaveLength(1);
    expect(facts[0].pass).toBe(2);
  });

  it("returns [] for invalid JSON", () => {
    expect(parseCandidateFacts("not-json", 1)).toEqual([]);
  });

  it("returns [] for non-array JSON", () => {
    expect(parseCandidateFacts('{"text":"fact"}', 1)).toEqual([]);
  });

  it("skips items with no text field", () => {
    const json = JSON.stringify([{ category: "other" }]);
    expect(parseCandidateFacts(json, 1)).toHaveLength(0);
  });

  it("skips items with empty text", () => {
    const json = JSON.stringify([{ text: "   ", category: "other", importance: 0.5 }]);
    expect(parseCandidateFacts(json, 1)).toHaveLength(0);
  });

  it("defaults category to 'other' when missing", () => {
    const json = JSON.stringify([{ text: "some fact", importance: 0.7 }]);
    const facts = parseCandidateFacts(json, 1);
    expect(facts[0].category).toBe("other");
  });

  it("defaults importance to 0.7 when out of range", () => {
    const json = JSON.stringify([{ text: "fact", category: "other", importance: 5 }]);
    const facts = parseCandidateFacts(json, 1);
    expect(facts[0].importance).toBe(0.7);
  });

  it("assigns the correct pass number to each fact", () => {
    const json = JSON.stringify([{ text: "fact", category: "other", importance: 0.5 }]);
    expect(parseCandidateFacts(json, 1)[0].pass).toBe(1);
    expect(parseCandidateFacts(json, 2)[0].pass).toBe(2);
  });

  it("parses multiple facts", () => {
    const json = JSON.stringify([
      { text: "Fact 1", category: "technical", importance: 0.9 },
      { text: "Fact 2", category: "workflow", importance: 0.6 },
    ]);
    expect(parseCandidateFacts(json, 1)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. parseVerdict
// ---------------------------------------------------------------------------

describe("parseVerdict", () => {
  it("returns CONFIRMED when response contains CONFIRMED", () => {
    expect(parseVerdict("CONFIRMED – the fact is accurate")).toBe("CONFIRMED");
  });

  it("returns REJECTED when response contains REJECTED", () => {
    expect(parseVerdict("REJECTED – not in transcript")).toBe("REJECTED");
  });

  it("returns UNCERTAIN for ambiguous response", () => {
    expect(parseVerdict("Maybe it's there")).toBe("UNCERTAIN");
  });

  it("is case-insensitive for CONFIRMED", () => {
    expect(parseVerdict("confirmed")).toBe("CONFIRMED");
  });

  it("is case-insensitive for REJECTED", () => {
    expect(parseVerdict("rejected")).toBe("REJECTED");
  });

  it("defaults to UNCERTAIN for unrecognised response", () => {
    expect(parseVerdict("I don't know")).toBe("UNCERTAIN");
  });

  it("REJECTED takes precedence when both appear (avoids 'REJECTED because ... CONFIRM' misclassification)", () => {
    expect(parseVerdict("REJECTED because the transcript does not CONFIRM this")).toBe("REJECTED");
    expect(parseVerdict("CONFIRMED but also REJECTED")).toBe("REJECTED");
  });

  it("NOT CONFIRMED / UNCONFIRMED do not return CONFIRMED", () => {
    expect(parseVerdict("NOT CONFIRMED, treat as UNCERTAIN")).toBe("UNCERTAIN");
    expect(parseVerdict("UNCONFIRMED")).toBe("UNCERTAIN");
  });
});

// ---------------------------------------------------------------------------
// 4. MultiPassExtractor.runPass1
// ---------------------------------------------------------------------------

describe("MultiPassExtractor.runPass1", () => {
  it("returns parsed candidates on success", async () => {
    const json = JSON.stringify([{ text: "Prefers TS", category: "preferences", importance: 0.9 }]);
    const openai = makeOpenAI([json]);
    const extractor = new MultiPassExtractor(openai as never);
    const result = await extractor.runPass1(TRANSCRIPT);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Prefers TS");
    expect(result[0].pass).toBe(1);
  });

  it("returns [] when LLM throws", async () => {
    const openai = makeOpenAI([new Error("LLM unavailable")]);
    const extractor = new MultiPassExtractor(openai as never);
    const result = await extractor.runPass1(TRANSCRIPT);
    expect(result).toEqual([]);
  });

  it("returns [] when LLM returns invalid JSON", async () => {
    const openai = makeOpenAI(["not-json"]);
    const extractor = new MultiPassExtractor(openai as never);
    const result = await extractor.runPass1(TRANSCRIPT);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. MultiPassExtractor.runPass2
// ---------------------------------------------------------------------------

describe("MultiPassExtractor.runPass2", () => {
  it("returns parsed candidates on success", async () => {
    const json = JSON.stringify([{ text: "Implicit preference for TS", category: "preferences", importance: 0.7 }]);
    const openai = makeOpenAI([json]);
    const extractor = new MultiPassExtractor(openai as never);
    const result = await extractor.runPass2(TRANSCRIPT);
    expect(result).toHaveLength(1);
    expect(result[0].pass).toBe(2);
  });

  it("returns [] when LLM throws", async () => {
    const openai = makeOpenAI([new Error("timeout")]);
    const extractor = new MultiPassExtractor(openai as never);
    const result = await extractor.runPass2(TRANSCRIPT);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. MultiPassExtractor.verifyCandidate
// ---------------------------------------------------------------------------

describe("MultiPassExtractor.verifyCandidate", () => {
  it("returns CONFIRMED when LLM says CONFIRMED", async () => {
    const openai = makeOpenAI(["CONFIRMED – clearly stated"]);
    const extractor = new MultiPassExtractor(openai as never);
    const verdict = await extractor.verifyCandidate(CANDIDATE, TRANSCRIPT);
    expect(verdict).toBe("CONFIRMED");
  });

  it("returns REJECTED when LLM says REJECTED", async () => {
    const openai = makeOpenAI(["REJECTED – not in transcript"]);
    const extractor = new MultiPassExtractor(openai as never);
    const verdict = await extractor.verifyCandidate(CANDIDATE, TRANSCRIPT);
    expect(verdict).toBe("REJECTED");
  });

  it("returns UNCERTAIN when LLM says UNCERTAIN", async () => {
    const openai = makeOpenAI(["UNCERTAIN – hard to tell"]);
    const extractor = new MultiPassExtractor(openai as never);
    const verdict = await extractor.verifyCandidate(CANDIDATE, TRANSCRIPT);
    expect(verdict).toBe("UNCERTAIN");
  });

  it("returns UNCERTAIN when LLM throws", async () => {
    const openai = makeOpenAI([new Error("network error")]);
    const extractor = new MultiPassExtractor(openai as never);
    const verdict = await extractor.verifyCandidate(CANDIDATE, TRANSCRIPT);
    expect(verdict).toBe("UNCERTAIN");
  });
});

// ---------------------------------------------------------------------------
// 7. MultiPassExtractor.extract — without verification
// ---------------------------------------------------------------------------

describe("MultiPassExtractor.extract — no verification", () => {
  it("combines Pass 1 and Pass 2 candidates and treats all as CONFIRMED", async () => {
    const pass1Json = JSON.stringify([{ text: "Fact from pass 1", category: "technical", importance: 0.8 }]);
    const pass2Json = JSON.stringify([{ text: "Fact from pass 2", category: "preferences", importance: 0.6 }]);
    const openai = makeOpenAI([pass1Json, pass2Json]);
    const extractor = new MultiPassExtractor(openai as never, { extractionPasses: true, verificationPass: false });
    const result = await extractor.extract(TRANSCRIPT);

    expect(result.explicitCount).toBe(1);
    expect(result.implicitCount).toBe(1);
    expect(result.rejectedCount).toBe(0);
    expect(result.facts).toHaveLength(2);
    expect(result.facts.every((f) => f.verdict === undefined)).toBe(true);
    expect(result.facts.every((f) => f.tags.length === 0)).toBe(true);
    expect(result.facts[0].pass).toBe(1);
    expect(result.facts[1].pass).toBe(2);
  });

  it("skips Pass 2 when extractionPasses=false", async () => {
    const pass1Json = JSON.stringify([{ text: "Explicit fact", category: "technical", importance: 0.9 }]);
    const openai = makeOpenAI([pass1Json]);
    const extractor = new MultiPassExtractor(openai as never, { extractionPasses: false, verificationPass: false });
    const result = await extractor.extract(TRANSCRIPT);

    expect(result.explicitCount).toBe(1);
    expect(result.implicitCount).toBe(0);
    expect(result.facts).toHaveLength(1);
  });

  it("returns empty when Pass 1 fails and extractionPasses=false", async () => {
    const openai = makeOpenAI([new Error("LLM down")]);
    const extractor = new MultiPassExtractor(openai as never, { extractionPasses: false });
    const result = await extractor.extract(TRANSCRIPT);

    expect(result.facts).toHaveLength(0);
    expect(result.explicitCount).toBe(0);
    expect(result.implicitCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
  });

  it("facts without verification have confidence = importance", async () => {
    const pass1Json = JSON.stringify([{ text: "A fact", category: "other", importance: 0.75 }]);
    const openai = makeOpenAI([pass1Json]);
    const extractor = new MultiPassExtractor(openai as never, { extractionPasses: false, verificationPass: false });
    const result = await extractor.extract(TRANSCRIPT);

    expect(result.facts[0].confidence).toBe(0.75);
    expect(result.facts[0].tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. MultiPassExtractor.extract — with verification
// ---------------------------------------------------------------------------

describe("MultiPassExtractor.extract — with verification", () => {
  it("CONFIRMED facts retain their original confidence", async () => {
    const pass1Json = JSON.stringify([{ text: "Confirmed fact", category: "technical", importance: 0.85 }]);
    const openai = makeOpenAI([pass1Json, "CONFIRMED – clearly stated"]);
    const extractor = new MultiPassExtractor(openai as never, {
      extractionPasses: false,
      verificationPass: true,
    });
    const result = await extractor.extract(TRANSCRIPT);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].verdict).toBe("CONFIRMED");
    expect(result.facts[0].confidence).toBe(0.85);
    expect(result.facts[0].tags).toEqual([]);
  });

  it("UNCERTAIN facts get confidence 0.4 and 'needs-review' tag", async () => {
    const pass1Json = JSON.stringify([{ text: "Uncertain fact", category: "context", importance: 0.7 }]);
    const openai = makeOpenAI([pass1Json, "UNCERTAIN – ambiguous"]);
    const extractor = new MultiPassExtractor(openai as never, {
      extractionPasses: false,
      verificationPass: true,
    });
    const result = await extractor.extract(TRANSCRIPT);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].verdict).toBe("UNCERTAIN");
    expect(result.facts[0].confidence).toBe(0.4);
    expect(result.facts[0].tags).toContain("needs-review");
  });

  it("REJECTED facts are excluded from output", async () => {
    const pass1Json = JSON.stringify([{ text: "Rejected fact", category: "other", importance: 0.6 }]);
    const openai = makeOpenAI([pass1Json, "REJECTED – not in transcript"]);
    const extractor = new MultiPassExtractor(openai as never, {
      extractionPasses: false,
      verificationPass: true,
    });
    const result = await extractor.extract(TRANSCRIPT);

    expect(result.facts).toHaveLength(0);
    expect(result.rejectedCount).toBe(1);
  });

  it("processes all candidates when multiple are present", async () => {
    const pass1Json = JSON.stringify([
      { text: "Fact one", category: "technical", importance: 0.9 },
      { text: "Fact two", category: "preferences", importance: 0.7 },
      { text: "Fact three", category: "other", importance: 0.5 },
    ]);
    // Pass 1, then verification verdicts: CONFIRMED, UNCERTAIN, REJECTED
    const openai = makeOpenAI([pass1Json, "CONFIRMED", "UNCERTAIN", "REJECTED"]);
    const extractor = new MultiPassExtractor(openai as never, {
      extractionPasses: false,
      verificationPass: true,
    });
    const result = await extractor.extract(TRANSCRIPT);

    expect(result.facts).toHaveLength(2);
    expect(result.rejectedCount).toBe(1);
    expect(result.facts[0].verdict).toBe("CONFIRMED");
    expect(result.facts[1].verdict).toBe("UNCERTAIN");
    expect(result.facts[1].confidence).toBe(0.4);
  });

  it("LLM error during verification is treated as UNCERTAIN", async () => {
    const pass1Json = JSON.stringify([{ text: "A fact", category: "other", importance: 0.8 }]);
    const openai = makeOpenAI([pass1Json, new Error("verification LLM failed")]);
    const extractor = new MultiPassExtractor(openai as never, {
      extractionPasses: false,
      verificationPass: true,
    });
    const result = await extractor.extract(TRANSCRIPT);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].verdict).toBe("UNCERTAIN");
    expect(result.facts[0].confidence).toBe(0.4);
  });
});

// ---------------------------------------------------------------------------
// 9. extractMultiPass convenience function
// ---------------------------------------------------------------------------

describe("extractMultiPass", () => {
  it("returns empty result when no facts are extracted", async () => {
    const openai = makeOpenAI(["[]", "[]"]);
    const result = await extractMultiPass(TRANSCRIPT, openai as never);
    expect(result.facts).toHaveLength(0);
    expect(result.explicitCount).toBe(0);
  });

  it("passes options through to MultiPassExtractor", async () => {
    const pass1Json = JSON.stringify([{ text: "A fact", category: "other", importance: 0.7 }]);
    const openai = makeOpenAI([pass1Json]);
    const result = await extractMultiPass(TRANSCRIPT, openai as never, {
      extractionPasses: false,
      verificationPass: false,
    });
    expect(result.facts).toHaveLength(1);
    expect(result.implicitCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. ExtractionConfig parsing
// ---------------------------------------------------------------------------

describe("ExtractionConfig parsing", () => {
  it("defaults to extractionPasses=false and verificationPass=false", () => {
    const cfg = hybridConfigSchema.parse({ ...BASE_CONFIG, mode: "minimal" });
    expect(cfg.extraction.extractionPasses).toBe(false);
    expect(cfg.extraction.verificationPass).toBe(false);
    expect(cfg.extraction.extractionModel).toBeUndefined();
    expect(cfg.extraction.implicitModel).toBeUndefined();
    expect(cfg.extraction.verificationModel).toBeUndefined();
  });

  it("parses extractionPasses=true correctly", () => {
    const cfg = hybridConfigSchema.parse({ ...BASE_CONFIG, extraction: { extractionPasses: true } });
    expect(cfg.extraction.extractionPasses).toBe(true);
  });

  it("parses verificationPass=true correctly", () => {
    const cfg = hybridConfigSchema.parse({ ...BASE_CONFIG, extraction: { verificationPass: true } });
    expect(cfg.extraction.verificationPass).toBe(true);
  });

  it("parses all model fields", () => {
    const cfg = hybridConfigSchema.parse({
      ...BASE_CONFIG,
      extraction: {
        extractionModel: "openai/gpt-4.1-nano",
        implicitModel: "openai/gpt-4.1-mini",
        verificationModel: "openai/gpt-4o-mini",
      },
    });
    expect(cfg.extraction.extractionModel).toBe("openai/gpt-4.1-nano");
    expect(cfg.extraction.implicitModel).toBe("openai/gpt-4.1-mini");
    expect(cfg.extraction.verificationModel).toBe("openai/gpt-4o-mini");
  });

  it("ignores empty string model names (sets undefined)", () => {
    const cfg = hybridConfigSchema.parse({
      ...BASE_CONFIG,
      extraction: { extractionModel: "   " },
    });
    expect(cfg.extraction.extractionModel).toBeUndefined();
  });
});
