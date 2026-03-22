import { describe, expect, it } from "vitest";
import {
  assessReflectionPromotionCandidates,
  buildPromotionInsightsBlock,
  summarizePromotionAssessments,
} from "../services/persona-promotion.js";
import type { MemoryEntry } from "../types/memory.js";

function mkFact(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: overrides.id ?? "fact-1",
    text: overrides.text ?? "Default reflection fact text",
    category: overrides.category ?? "pattern",
    importance: overrides.importance ?? 0.7,
    entity: overrides.entity ?? null,
    key: overrides.key ?? null,
    value: overrides.value ?? null,
    source: overrides.source ?? "reflection",
    createdAt: overrides.createdAt ?? 1_700_000_000,
    decayClass: overrides.decayClass ?? "permanent",
    expiresAt: overrides.expiresAt ?? null,
    lastConfirmedAt: overrides.lastConfirmedAt ?? 1_700_000_000,
    confidence: overrides.confidence ?? 0.9,
    tags: overrides.tags ?? ["reflection", "pattern"],
    sourceSessions: overrides.sourceSessions,
    reinforcedCount: overrides.reinforcedCount,
    supersededAt: overrides.supersededAt,
  };
}

describe("persona promotion pipeline", () => {
  it("classifies durable vs useful vs transient reflection insights", () => {
    const nowSec = 1_700_000_000;
    const facts: MemoryEntry[] = [
      mkFact({
        id: "durable-1",
        category: "rule",
        tags: ["reflection", "rule", "meta"],
        sourceSessions: "s1,s2,s3",
        reinforcedCount: 2,
        createdAt: nowSec - 9 * 86400,
        confidence: 0.92,
      }),
      mkFact({
        id: "useful-1",
        category: "pattern",
        tags: ["reflection", "pattern"],
        sourceSessions: "s1",
        reinforcedCount: 0,
        createdAt: nowSec - 3 * 86400,
        confidence: 0.8,
      }),
      mkFact({
        id: "transient-1",
        category: "pattern",
        tags: ["reflection", "pattern"],
        sourceSessions: "",
        reinforcedCount: 0,
        createdAt: nowSec - 3600,
        confidence: 0.3,
      }),
    ];

    const assessed = assessReflectionPromotionCandidates(facts, nowSec);
    const byId = new Map(assessed.map((x) => [x.factId, x]));

    expect(byId.get("durable-1")?.classification).toBe("durable_for_promotion");
    expect(byId.get("useful-1")?.classification).toBe("useful_non_durable");
    expect(byId.get("transient-1")?.classification).toBe("transient");

    const summary = summarizePromotionAssessments(assessed);
    expect(summary).toEqual({ durableForPromotion: 1, usefulNonDurable: 1, transient: 1 });
  });

  it("builds insights block with durable fact provenance identifiers", () => {
    const nowSec = 1_700_000_000;
    const assessed = assessReflectionPromotionCandidates(
      [
        mkFact({
          id: "durable-a",
          category: "rule",
          tags: ["reflection", "rule", "meta"],
          sourceSessions: JSON.stringify(["session-1", "session-2"]),
          reinforcedCount: 1,
          createdAt: nowSec - 10 * 86400,
          confidence: 0.9,
        }),
      ],
      nowSec,
    );

    const block = buildPromotionInsightsBlock(assessed);
    expect(block).toContain("Durable promotion candidates:");
    expect(block).toContain("[fact:durable-a]");
    expect(block).toContain("Transient reflections not promoted:");
  });
});
