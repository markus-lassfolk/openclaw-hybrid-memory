import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IdentityReflectionStore } from "../backends/identity-reflection-store.js";
import { PersonaStateStore } from "../backends/persona-state-store.js";
import {
  buildPersonaStateInsightsBlock,
  calculatePersonaInsightSimilarity,
  collectPersonaPromotionCandidates,
  promotePersonaStateFromReflections,
} from "../services/persona-state-promotion.js";
import type { IdentityPromotionConfig } from "../config/types/capture.js";

const PROMOTION_CFG: IdentityPromotionConfig = {
  enabled: true,
  lookbackDays: 90,
  minDurableReflections: 2,
  minConfidence: 0.72,
  similarityThreshold: 0.6,
  maxPromotionsPerRun: 8,
};

describe("persona-state promotion pipeline", () => {
  let dir: string;
  let reflectionStore: IdentityReflectionStore;
  let personaStateStore: PersonaStateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "persona-state-"));
    reflectionStore = new IdentityReflectionStore(join(dir, "identity-reflections.db"));
    personaStateStore = new PersonaStateStore(join(dir, "persona-state.db"));
  });

  afterEach(() => {
    reflectionStore.close();
    personaStateStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("groups paraphrased durable reflections into one promotion candidate", () => {
    reflectionStore.create({
      runId: "run-1",
      questionKey: "partnership",
      questionText: "What patterns define good partnership with the user?",
      insight: "I work best when I explain tradeoffs clearly and keep the user looped into decisions.",
      durability: "durable",
      confidence: 0.82,
      evidence: ["Explains tradeoffs", "Invites user decisions"],
    });
    reflectionStore.create({
      runId: "run-2",
      questionKey: "partnership",
      questionText: "What patterns define good partnership with the user?",
      insight: "Good partnership means I surface tradeoffs clearly and keep the user involved in decisions.",
      durability: "durable",
      confidence: 0.86,
      evidence: ["Surfaces tradeoffs", "Keeps user involved"],
    });

    const candidates = collectPersonaPromotionCandidates(reflectionStore.listRecent(20), PROMOTION_CFG);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].durableCount).toBe(2);
    expect(candidates[0].targetFile).toBe("SOUL.md");
    expect(candidates[0].averageConfidence).toBeGreaterThan(0.8);
  });

  it("does not promote temporary or weakly supported reflections", () => {
    reflectionStore.create({
      runId: "run-1",
      questionKey: "tradeoffs",
      questionText: "What kinds of tradeoffs do I keep making?",
      insight: "I currently prefer shorter answers over detailed exploration.",
      durability: "temporary",
      confidence: 0.9,
      evidence: ["Recent short answers"],
    });
    reflectionStore.create({
      runId: "run-2",
      questionKey: "tradeoffs",
      questionText: "What kinds of tradeoffs do I keep making?",
      insight: "I prefer concise answers right now.",
      durability: "durable",
      confidence: 0.65,
      evidence: ["Short answer preference"],
    });

    const candidates = collectPersonaPromotionCandidates(reflectionStore.listRecent(20), PROMOTION_CFG);
    expect(candidates).toHaveLength(0);
  });

  it("creates then updates durable persona state without duplicating state rows", () => {
    const first = reflectionStore.create({
      runId: "run-1",
      questionKey: "protect",
      questionText: "What do I reliably protect?",
      insight: "I protect user context by preserving constraints before I optimize for speed.",
      durability: "durable",
      confidence: 0.81,
      evidence: ["Preserves constraints", "Avoids hasty optimization"],
    });
    const second = reflectionStore.create({
      runId: "run-2",
      questionKey: "protect",
      questionText: "What do I reliably protect?",
      insight: "I reliably preserve user constraints before optimizing for speed or convenience.",
      durability: "durable",
      confidence: 0.88,
      evidence: ["Preserves user constraints", "Resists convenience-first shortcuts"],
    });

    const initial = promotePersonaStateFromReflections(reflectionStore, personaStateStore, PROMOTION_CFG);
    expect(initial.promoted).toBe(1);
    expect(initial.updated).toBe(0);
    expect(personaStateStore.count()).toBe(1);
    expect(initial.entries[0].sourceReflectionIds.sort()).toEqual([first.id, second.id].sort());

    reflectionStore.create({
      runId: "run-3",
      questionKey: "protect",
      questionText: "What do I reliably protect?",
      insight: "I protect the user's stated constraints before I optimize for speed.",
      durability: "durable",
      confidence: 0.9,
      evidence: ["Protects stated constraints"],
    });

    const updated = promotePersonaStateFromReflections(reflectionStore, personaStateStore, PROMOTION_CFG);
    expect(updated.promoted).toBe(0);
    expect(updated.updated).toBe(1);
    expect(personaStateStore.count()).toBe(1);
    expect(updated.entries[0].durableCount).toBe(3);
  });

  it("formats durable persona state for proposal prompts", () => {
    reflectionStore.create({
      runId: "run-1",
      questionKey: "identity",
      questionText: "Who am I?",
      insight: "My name and avatar should be treated as part of my stable identity presentation.",
      durability: "durable",
      confidence: 0.82,
      evidence: ["Name reference"],
    });
    reflectionStore.create({
      runId: "run-2",
      questionKey: "identity",
      questionText: "Who am I?",
      insight: "My stable identity presentation includes my name and avatar.",
      durability: "durable",
      confidence: 0.85,
      evidence: ["Avatar reference"],
    });

    const promotion = promotePersonaStateFromReflections(reflectionStore, personaStateStore, PROMOTION_CFG);
    const block = buildPersonaStateInsightsBlock(promotion.entries);
    expect(block).toContain("IDENTITY.md");
    expect(block).toContain("durable_count=2");
  });
});

describe("calculatePersonaInsightSimilarity", () => {
  it("scores paraphrases higher than unrelated text", () => {
    const similar = calculatePersonaInsightSimilarity(
      "I explain tradeoffs clearly and keep the user involved.",
      "I keep the user involved and make tradeoffs explicit.",
    );
    const different = calculatePersonaInsightSimilarity(
      "I explain tradeoffs clearly and keep the user involved.",
      "I adopt a playful fantasy creature persona.",
    );

    expect(similar).toBeGreaterThan(0.5);
    expect(different).toBeLessThan(0.3);
  });
});
