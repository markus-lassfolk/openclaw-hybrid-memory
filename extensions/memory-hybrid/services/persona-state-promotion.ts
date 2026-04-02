import type { IdentityReflectionEntry, IdentityReflectionStore } from "../backends/identity-reflection-store.js";
import type { PersonaStateEntry, PersonaStateStore } from "../backends/persona-state-store.js";
import type { IdentityFileType } from "../config/types/agents.js";
import type { IdentityPromotionConfig } from "../config/types/capture.js";
import { uniqueStrings } from "../utils/text.js";

const INSIGHT_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "when",
  "with",
]);

interface PersonaPromotionCandidate {
  stateKey: string;
  questionKey: string;
  targetFile: IdentityFileType;
  insight: string;
  normalizedInsight: string;
  averageConfidence: number;
  durableCount: number;
  evidence: string[];
  sourceReflectionIds: string[];
  firstSeenAt: number;
  lastSeenAt: number;
}

interface PersonaPromotionResult {
  reflectionsReviewed: number;
  durableReflections: number;
  candidatesFound: number;
  promoted: number;
  updated: number;
  unchanged: number;
  entries: PersonaStateEntry[];
}

function normalizePersonaInsight(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeInsight(text: string): string[] {
  return normalizePersonaInsight(text)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !INSIGHT_STOPWORDS.has(token));
}

function buildCharacterBigrams(text: string): string[] {
  const normalized = ` ${normalizePersonaInsight(text)} `;
  const bigrams: string[] = [];
  for (let index = 0; index < normalized.length - 1; index++) {
    bigrams.push(normalized.slice(index, index + 2));
  }
  return bigrams;
}

function diceCoefficient(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightCounts = new Map<string, number>();
  for (const token of right) {
    rightCounts.set(token, (rightCounts.get(token) ?? 0) + 1);
  }
  let intersection = 0;
  for (const token of left) {
    const remaining = rightCounts.get(token) ?? 0;
    if (remaining <= 0) continue;
    intersection++;
    rightCounts.set(token, remaining - 1);
  }
  return (2 * intersection) / (left.length + right.length);
}

export function calculatePersonaInsightSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokenizeInsight(left));
  const rightTokens = new Set(tokenizeInsight(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return normalizePersonaInsight(left) === normalizePersonaInsight(right) ? 1 : 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection++;
  }
  const tokenSimilarity = (2 * intersection) / (leftTokens.size + rightTokens.size);
  const bigramSimilarity = diceCoefficient(buildCharacterBigrams(left), buildCharacterBigrams(right));
  return Math.max(tokenSimilarity, bigramSimilarity);
}

function inferPersonaTargetFile(questionKey: string, insight: string): IdentityFileType {
  const combined = `${questionKey} ${insight}`.toLowerCase();
  if (/\b(name|identity|avatar|creature|role|vibe|species|origin)\b/.test(combined)) {
    return "IDENTITY.md";
  }
  return "SOUL.md";
}

function buildStateKey(questionKey: string, insight: string): string {
  const tokenSignature = uniqueStrings(tokenizeInsight(insight)).sort().slice(0, 12).join("-");
  const stablePart = tokenSignature || normalizePersonaInsight(insight).slice(0, 160);
  return `${questionKey}::${stablePart}`;
}

export function collectPersonaPromotionCandidates(
  reflections: IdentityReflectionEntry[],
  config: IdentityPromotionConfig,
): PersonaPromotionCandidate[] {
  const lookbackCutoff = Math.floor(Date.now() / 1000) - config.lookbackDays * 24 * 3600;
  const durable = reflections
    .filter((entry) => entry.durability === "durable" && entry.createdAt >= lookbackCutoff)
    .sort((left, right) => left.createdAt - right.createdAt);

  const clusters: Array<{
    stateKey: string;
    questionKey: string;
    canonicalInsight: string;
    normalizedInsight: string;
    targetFile: IdentityFileType;
    confidenceSum: number;
    durableCount: number;
    evidence: string[];
    sourceReflectionIds: string[];
    firstSeenAt: number;
    lastSeenAt: number;
  }> = [];

  for (const reflection of durable) {
    const match = clusters.find(
      (cluster) =>
        cluster.questionKey === reflection.questionKey &&
        calculatePersonaInsightSimilarity(cluster.canonicalInsight, reflection.insight) >= config.similarityThreshold,
    );
    if (!match) {
      clusters.push({
        stateKey: buildStateKey(reflection.questionKey, reflection.insight),
        questionKey: reflection.questionKey,
        canonicalInsight: reflection.insight,
        normalizedInsight: normalizePersonaInsight(reflection.insight),
        targetFile: inferPersonaTargetFile(reflection.questionKey, reflection.insight),
        confidenceSum: reflection.confidence,
        durableCount: 1,
        evidence: [...reflection.evidence],
        sourceReflectionIds: [reflection.id],
        firstSeenAt: reflection.createdAt,
        lastSeenAt: reflection.createdAt,
      });
      continue;
    }

    match.confidenceSum += reflection.confidence;
    match.durableCount += 1;
    match.evidence.push(...reflection.evidence);
    match.sourceReflectionIds.push(reflection.id);
    match.lastSeenAt = Math.max(match.lastSeenAt, reflection.createdAt);
    if (
      reflection.confidence > match.confidenceSum / match.durableCount ||
      reflection.insight.length > match.canonicalInsight.length
    ) {
      match.canonicalInsight = reflection.insight;
      match.normalizedInsight = normalizePersonaInsight(reflection.insight);
      match.targetFile = inferPersonaTargetFile(reflection.questionKey, reflection.insight);
    }
  }

  return clusters
    .map((cluster) => ({
      stateKey: buildStateKey(cluster.questionKey, cluster.canonicalInsight),
      questionKey: cluster.questionKey,
      targetFile: cluster.targetFile,
      insight: cluster.canonicalInsight,
      normalizedInsight: cluster.normalizedInsight,
      averageConfidence: cluster.confidenceSum / Math.max(1, cluster.durableCount),
      durableCount: cluster.durableCount,
      evidence: uniqueStrings(cluster.evidence).slice(0, 8),
      sourceReflectionIds: uniqueStrings(cluster.sourceReflectionIds),
      firstSeenAt: cluster.firstSeenAt,
      lastSeenAt: cluster.lastSeenAt,
    }))
    .filter(
      (candidate) =>
        candidate.durableCount >= config.minDurableReflections && candidate.averageConfidence >= config.minConfidence,
    )
    .sort((left, right) => right.durableCount - left.durableCount || right.averageConfidence - left.averageConfidence)
    .slice(0, config.maxPromotionsPerRun);
}

export function buildPersonaStateInsightsBlock(entries: PersonaStateEntry[]): string {
  if (entries.length === 0) return "";
  return entries
    .map(
      (entry) =>
        `- [${entry.targetFile}] ${entry.insight} (question=${entry.questionKey}; durable_count=${entry.durableCount}; confidence=${entry.confidence.toFixed(2)})`,
    )
    .join("\n");
}

export function promotePersonaStateFromReflections(
  reflectionStore: IdentityReflectionStore,
  personaStateStore: PersonaStateStore,
  config: IdentityPromotionConfig,
  opts?: { dryRun?: boolean; limit?: number },
): PersonaPromotionResult {
  if (!config.enabled) {
    return {
      reflectionsReviewed: 0,
      durableReflections: 0,
      candidatesFound: 0,
      promoted: 0,
      updated: 0,
      unchanged: 0,
      entries: [],
    };
  }

  const reflections = reflectionStore.listRecent(opts?.limit ?? 250);
  const durableReflections = reflections.filter((entry) => entry.durability === "durable");
  const candidates = collectPersonaPromotionCandidates(reflections, config);
  const entries: PersonaStateEntry[] = [];
  let promoted = 0;
  let updated = 0;
  let unchanged = 0;

  const existingEntries = personaStateStore.listRecent(100);

  for (const candidate of candidates) {
    const matchingEntry = existingEntries.find(
      (entry) =>
        entry.questionKey === candidate.questionKey &&
        calculatePersonaInsightSimilarity(entry.insight, candidate.insight) >= config.similarityThreshold,
    );
    if (matchingEntry) {
      candidate.stateKey = matchingEntry.stateKey;
    }

    if (opts?.dryRun) {
      entries.push({
        id: candidate.stateKey,
        stateKey: candidate.stateKey,
        questionKey: candidate.questionKey,
        targetFile: candidate.targetFile,
        insight: candidate.insight,
        normalizedInsight: candidate.normalizedInsight,
        confidence: candidate.averageConfidence,
        durableCount: candidate.durableCount,
        evidence: candidate.evidence,
        sourceReflectionIds: candidate.sourceReflectionIds,
        firstSeenAt: candidate.firstSeenAt,
        lastSeenAt: candidate.lastSeenAt,
        promotedAt: candidate.lastSeenAt,
        updatedAt: candidate.lastSeenAt,
      });
      if (matchingEntry) {
        updated++;
      } else {
        promoted++;
      }
      continue;
    }

    const result = personaStateStore.upsert({
      stateKey: candidate.stateKey,
      questionKey: candidate.questionKey,
      targetFile: candidate.targetFile,
      insight: candidate.insight,
      normalizedInsight: candidate.normalizedInsight,
      confidence: candidate.averageConfidence,
      durableCount: candidate.durableCount,
      evidence: candidate.evidence,
      sourceReflectionIds: candidate.sourceReflectionIds,
      firstSeenAt: candidate.firstSeenAt,
      lastSeenAt: candidate.lastSeenAt,
    });
    if (result.action === "created") promoted++;
    else if (result.action === "updated") updated++;
    else unchanged++;
    entries.push(result.entry);
  }

  return {
    reflectionsReviewed: reflections.length,
    durableReflections: durableReflections.length,
    candidatesFound: candidates.length,
    promoted,
    updated,
    unchanged,
    entries,
  };
}
