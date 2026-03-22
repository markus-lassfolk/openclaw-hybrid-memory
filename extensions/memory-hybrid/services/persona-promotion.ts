import type { MemoryEntry } from "../types/memory.js";

export type ReflectionPromotionClass = "transient" | "useful_non_durable" | "durable_for_promotion";

export type ReflectionPromotionAssessment = {
  factId: string;
  text: string;
  category: string;
  classification: ReflectionPromotionClass;
  durabilityScore: number;
  reasons: string[];
  tags: string[];
  reinforcedCount: number;
  sourceEvidenceCount: number;
  createdAt: number;
};

export type ReflectionPromotionSummary = {
  transient: number;
  usefulNonDurable: number;
  durableForPromotion: number;
};

export const DURABILITY_THRESHOLD_DURABLE = 4;
export const DURABILITY_THRESHOLD_USEFUL = 2;

function parseSourceEvidenceCount(raw: string | null | undefined): number {
  if (!raw || typeof raw !== "string") return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return new Set(parsed.map((x) => String(x).trim()).filter(Boolean)).size;
    }
  } catch {
    // Fall through to comma-separated parsing.
  }

  return new Set(
    trimmed
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  ).size;
}

function classifyDurability(score: number): ReflectionPromotionClass {
  if (score >= DURABILITY_THRESHOLD_DURABLE) return "durable_for_promotion";
  if (score >= DURABILITY_THRESHOLD_USEFUL) return "useful_non_durable";
  return "transient";
}

export function assessReflectionPromotionCandidates(
  facts: MemoryEntry[],
  nowSec = Math.floor(Date.now() / 1000),
): ReflectionPromotionAssessment[] {
  const filtered = facts.filter(
    (f) =>
      (f.category === "pattern" || f.category === "rule") &&
      !f.supersededAt &&
      (f.expiresAt === null || f.expiresAt > nowSec) &&
      (f.tags?.includes("reflection") ?? false),
  );

  return filtered.map((fact) => {
    const reasons: string[] = [];
    const tags = Array.isArray(fact.tags) ? fact.tags : [];
    const sourceEvidenceCount = parseSourceEvidenceCount(fact.sourceSessions);
    const reinforcedCount = Number(fact.reinforcedCount ?? 0);
    const confidence = Number.isFinite(fact.confidence) ? fact.confidence : 0;
    const ageDays = Math.max(0, (nowSec - (fact.createdAt ?? nowSec)) / 86400);
    let score = 0;

    if (fact.category === "rule") {
      score += 1;
      reasons.push("actionable rule");
    }
    if (tags.includes("meta")) {
      score += 1;
      reasons.push("meta-pattern synthesis");
    }
    if (sourceEvidenceCount >= 2) {
      score += 2;
      reasons.push(`multi-session evidence (${sourceEvidenceCount})`);
    } else if (sourceEvidenceCount === 1) {
      score += 1;
      reasons.push("single-session evidence");
    }
    if (reinforcedCount >= 2) {
      score += 2;
      reasons.push(`repeated reinforcement (${reinforcedCount})`);
    } else if (reinforcedCount === 1) {
      score += 1;
      reasons.push("reinforced once");
    }
    if (confidence >= 0.8) {
      score += 1;
      reasons.push(`high confidence (${confidence.toFixed(2)})`);
    }
    if (ageDays >= 7) {
      score += 1;
      reasons.push(`stable over time (${Math.floor(ageDays)}d old)`);
    } else if (ageDays < 2) {
      score -= 1;
      reasons.push("very recent; treat as less durable");
    }

    return {
      factId: fact.id,
      text: fact.text,
      category: fact.category,
      classification: classifyDurability(score),
      durabilityScore: score,
      reasons,
      tags,
      reinforcedCount,
      sourceEvidenceCount,
      createdAt: fact.createdAt,
    };
  });
}

export function summarizePromotionAssessments(items: ReflectionPromotionAssessment[]): ReflectionPromotionSummary {
  let transient = 0;
  let usefulNonDurable = 0;
  let durableForPromotion = 0;
  for (const item of items) {
    if (item.classification === "durable_for_promotion") durableForPromotion++;
    else if (item.classification === "useful_non_durable") usefulNonDurable++;
    else transient++;
  }
  return { transient, usefulNonDurable, durableForPromotion };
}

export function buildPromotionInsightsBlock(items: ReflectionPromotionAssessment[]): string {
  const durable = items
    .filter((x) => x.classification === "durable_for_promotion")
    .sort((a, b) => b.durabilityScore - a.durabilityScore)
    .slice(0, 30);
  const useful = items
    .filter((x) => x.classification === "useful_non_durable")
    .sort((a, b) => b.durabilityScore - a.durabilityScore)
    .slice(0, 20);
  const transientCount = items.filter((x) => x.classification === "transient").length;

  const lines: string[] = [];
  if (durable.length > 0) {
    lines.push("Durable promotion candidates:");
    for (const x of durable) {
      const tags = x.tags.length > 0 ? ` tags=${x.tags.join("|")}` : "";
      lines.push(
        `- [fact:${x.factId}] score=${x.durabilityScore} category=${x.category}${tags} evidence=${x.sourceEvidenceCount} reinforced=${x.reinforcedCount} :: ${x.text}`,
      );
    }
  }
  if (useful.length > 0) {
    lines.push("");
    lines.push("Useful but not yet durable:");
    for (const x of useful) {
      lines.push(`- [fact:${x.factId}] score=${x.durabilityScore} :: ${x.text}`);
    }
  }
  lines.push("");
  lines.push(`Transient reflections not promoted: ${transientCount}`);

  return lines.join("\n");
}
