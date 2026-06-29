/**
 * Durable-rule destination classifier for persona proposals (#2002).
 *
 * Multi-gate assessment: authority-bucket routing, cross-surface semantic dedup,
 * and contradiction detection against reflection rules and authority files.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { MemoryEntry } from "../types/memory.js";
import { normalizeProposalText } from "../cli/proposals.js";
import type { PersonaRuleRoutingConfig } from "../config/types/agents.js";
import { cosineSimilarity } from "./ambient-retrieval.js";

export type AuthorityTarget =
  | "SOUL.md"
  | "IDENTITY.md"
  | "USER.md"
  | "AGENTS.md"
  | "TOOLS.md"
  | "skill_workshop"
  | "memory_fact";

export type PersonaProposalDisposition = "propose" | "retarget" | "merge" | "manual-review" | "reject";

export type RuleRoutingEvidence = {
  type: "rule" | "file-section" | "skill" | "memory-fact" | "contradiction-degraded";
  id?: string;
  summary: string;
  similarity?: number;
  location?: string;
  snippet?: string;
};

export type DedupCandidate = RuleRoutingEvidence & {
  source: "memory-fact" | "file-section" | "skill";
  mergeWith?: boolean;
};

export type ContradictionCandidate = RuleRoutingEvidence & {
  existingRuleId?: string;
  existingLocation?: string;
  decision?: "manual_review" | "merge" | "supersedes";
  mergedRuleText?: string | null;
};

export type PersonaProposalAssessment = {
  supportScore: number;
  routingScore: number;
  dedupScore: number;
  contradictionRisk: number;
  mutationRisk: number;
  llmConfidenceHint?: number;
  overallDisposition: PersonaProposalDisposition;
  recommendedTargetFile: AuthorityTarget;
  routingRationale: string;
  routingSuggestion?: {
    recommendedTargetFile: string;
    rationale: string;
    callerTargetFile: string;
  };
  dedupCandidates: DedupCandidate[];
  contradictionCandidates: ContradictionCandidate[];
  evidence: RuleRoutingEvidence[];
  humanReviewRequired: boolean;
  applyAllowed: boolean;
  contradiction: boolean;
  /** Hard block reason for proposal creation (duplicate-rule, enforce-routing, etc.). */
  blockReason?: "duplicate-rule" | "near-duplicate-rule" | "already-in-file" | "enforce-routing" | "low-support";
  blockCandidate?: {
    source: string;
    location: string;
    snippet: string;
    similarity?: number;
  };
};

export type RuleContradictionAdjudication = {
  decision: "manual_review" | "merge" | "supersedes";
  reason: string;
  mergedRuleText?: string | null;
};

export type RoutePersonaProposalInput = {
  targetFile: string;
  title: string;
  observation: string;
  suggestedChange: string;
  confidence: number;
  evidenceSessions: string[];
  workspaceRoot: string;
  allowedFiles: readonly string[];
  routing: PersonaRuleRoutingConfig;
  factsDb?: FactsDB | null;
  embedText?: (text: string) => Promise<number[]>;
  adjudicateContradiction?: (
    proposed: string,
    existing: string,
  ) => Promise<RuleContradictionAdjudication | null>;
};

export const DEFAULT_PERSONA_RULE_ROUTING: PersonaRuleRoutingConfig = {
  enabled: true,
  routingMode: "advisory",
  semanticDedup: { enabled: true },
  dedupeThreshold: 0.92,
  nearDedupeThreshold: 0.75,
  contradictionThreshold: 0.6,
  routingCacheTtlSeconds: 3600,
  topK: 8,
};

export const AUTHORITY_FILE_TARGETS = ["AGENTS.md", "TOOLS.md", "SOUL.md", "USER.md", "IDENTITY.md"] as const;

const BUCKET_PRIORITY: AuthorityTarget[] = [
  "skill_workshop",
  "AGENTS.md",
  "TOOLS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "memory_fact",
];

const BUCKET_PATTERNS: Record<Exclude<AuthorityTarget, "memory_fact">, RegExp[]> = {
  "AGENTS.md": [
    /\b(github|issue|pr|pull request|commit|ci|cron|dispatch|gate|council|workflow|omnibus|triage|stewardship)\b/i,
  ],
  "TOOLS.md": [/\b(host|hostname|port|wrapper|alias|local path|\/usr\/|\/mnt\/)\b/i],
  "SOUL.md": [/\b(values|principles|ethos|character|integrity|honesty|helpful)\b/i],
  "USER.md": [/\b(user preference|profile|personal fact|communication style|timezone|locale)\b/i],
  "IDENTITY.md": [/\b(name|persona|identity|voice|tone|role|agent name)\b/i],
  skill_workshop: [
    /\b(reusable|playbook|recurring workflow|step \d|^\d+\.|procedure)\b/im,
    /\b(first,|second,|third,|then .+ then .+ then)\b/i,
  ],
};

const OPERATIONAL_FAMILY = new Set<string>(["AGENTS.md", "TOOLS.md"]);
const IDENTITY_FAMILY = new Set<string>(["SOUL.md", "IDENTITY.md"]);

const embeddingCache = new Map<string, { vector: number[]; expiresAt: number }>();

export const personaRuleRoutingMetrics = {
  routingSuggestions: 0,
  dedupHits: 0,
  contradictionHits: 0,
  contradictionDegraded: 0,
};

export function resetPersonaRuleRoutingMetrics(): void {
  personaRuleRoutingMetrics.routingSuggestions = 0;
  personaRuleRoutingMetrics.dedupHits = 0;
  personaRuleRoutingMetrics.contradictionHits = 0;
  personaRuleRoutingMetrics.contradictionDegraded = 0;
}

function bucketPriorityIndex(bucket: AuthorityTarget): number {
  const idx = BUCKET_PRIORITY.indexOf(bucket);
  return idx >= 0 ? idx : BUCKET_PRIORITY.length;
}

function proposalBody(input: Pick<RoutePersonaProposalInput, "title" | "observation" | "suggestedChange">): string {
  return `${input.title}\n${input.observation}\n${input.suggestedChange}`;
}

function scoreBucket(text: string, bucket: Exclude<AuthorityTarget, "memory_fact">): number {
  const patterns = BUCKET_PATTERNS[bucket];
  let hits = 0;
  for (const re of patterns) {
    if (re.test(text)) hits += 1;
  }
  if (hits === 0) return 0;
  return Math.min(1, 0.55 + hits * 0.15);
}

export function classifyAuthorityBucket(text: string): {
  bucket: AuthorityTarget;
  routingScore: number;
  rationale: string;
} {
  const normalized = text.toLowerCase();
  if (/\b(remember|store|recall|on next turn)\b/i.test(normalized) && normalized.split(/\s+/).length <= 24) {
    return {
      bucket: "memory_fact",
      routingScore: 0.65,
      rationale: "Declarative recall instruction suited to a memory fact, not a persona file.",
    };
  }

  let best: { bucket: AuthorityTarget; routingScore: number; rationale: string } | null = null;
  for (const bucket of BUCKET_PRIORITY) {
    if (bucket === "memory_fact") continue;
    const score = scoreBucket(text, bucket);
    if (score <= 0) continue;
    const candidate = {
      bucket,
      routingScore: score,
      rationale: bucketRationale(bucket),
    };
    if (!best || bucketPriorityIndex(candidate.bucket) < bucketPriorityIndex(best.bucket)) {
      best = candidate;
    } else if (
      best &&
      bucketPriorityIndex(candidate.bucket) === bucketPriorityIndex(best.bucket) &&
      candidate.routingScore > best.routingScore
    ) {
      best = candidate;
    }
  }

  if (best) return best;
  return {
    bucket: "USER.md",
    routingScore: 0.5,
    rationale: "No strong operational or identity signals; defaulting to user-context guidance.",
  };
}

function bucketRationale(bucket: AuthorityTarget): string {
  switch (bucket) {
    case "AGENTS.md":
      return "Operational workflow rule (GitHub/issue/PR/CI/dispatch/gate semantics).";
    case "TOOLS.md":
      return "Local environment or tool invocation specifics.";
    case "SOUL.md":
      return "Values or principles guidance.";
    case "USER.md":
      return "User-specific preference or profile guidance.";
    case "IDENTITY.md":
      return "Agent identity, voice, or role guidance.";
    case "skill_workshop":
      return "Multi-step recurring procedure better promoted as a named skill.";
    case "memory_fact":
      return "Machine-readable recall instruction.";
    default:
      return "Authority file routing.";
  }
}

function computeSupportScore(input: RoutePersonaProposalInput): number {
  const evidenceBoost = Math.min(0.25, Math.max(0, input.evidenceSessions.length - 1) * 0.05);
  const base = Math.max(0, Math.min(1, input.confidence));
  return Math.min(1, base * 0.85 + evidenceBoost + (input.observation.trim().length > 40 ? 0.05 : 0));
}

function computeMutationRisk(targetFile: string, suggestedChange: string): number {
  if (targetFile === "SOUL.md" || targetFile === "IDENTITY.md") return 0.85;
  if (targetFile === "USER.md") return 0.7;
  if (/^\s*replace\b/i.test(suggestedChange)) return 0.8;
  if (targetFile === "AGENTS.md" || targetFile === "TOOLS.md") return 0.45;
  return 0.55;
}

function sameBucketFamily(a: string, b: string): boolean {
  if (a === b) return true;
  if (OPERATIONAL_FAMILY.has(a) && OPERATIONAL_FAMILY.has(b)) return true;
  if (IDENTITY_FAMILY.has(a) && IDENTITY_FAMILY.has(b)) return true;
  return false;
}

function hashCacheKey(text: string): string {
  return createHash("sha256").update(normalizeProposalText(text)).digest("hex");
}

async function cachedEmbed(
  text: string,
  embedText: ((text: string) => Promise<number[]>) | undefined,
  ttlSeconds: number,
): Promise<number[] | null> {
  if (!embedText) return null;
  const key = hashCacheKey(text);
  const now = Date.now();
  const cached = embeddingCache.get(key);
  if (cached && cached.expiresAt > now) return cached.vector;
  try {
    const vector = await embedText(text);
    embeddingCache.set(key, { vector, expiresAt: now + ttlSeconds * 1000 });
    return vector;
  } catch {
    return null;
  }
}

function readAuthorityFileSections(workspaceRoot: string, files: readonly string[]): Array<{
  file: string;
  text: string;
}> {
  const out: Array<{ file: string; text: string }> = [];
  for (const file of files) {
    const path = join(workspaceRoot, file);
    if (!existsSync(path)) continue;
    try {
      out.push({ file, text: readFileSync(path, "utf-8") });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

function splitSubstantiveSections(text: string): string[] {
  return text
    .split(/\n{2,}|(?=^#{1,3} )/m)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30);
}

export function findCrossFileContentMatch(input: {
  suggestedChange: string;
  workspaceRoot: string;
  excludeFile?: string;
  authorityFiles?: readonly string[];
}): { file: string; snippet: string } | null {
  const files = input.authorityFiles ?? AUTHORITY_FILE_TARGETS;
  const normalizedChange = normalizeProposalText(input.suggestedChange);
  if (normalizedChange.length < 20) return null;

  for (const { file, text } of readAuthorityFileSections(input.workspaceRoot, files)) {
    if (input.excludeFile && file === input.excludeFile) continue;
    const normalizedFile = normalizeProposalText(text);
    if (normalizedFile.includes(normalizedChange)) {
      return { file, snippet: input.suggestedChange.slice(0, 160) };
    }
    for (const section of splitSubstantiveSections(text)) {
      if (normalizeProposalText(section) === normalizedChange) {
        return { file, snippet: section.slice(0, 160) };
      }
    }
  }
  return null;
}

function listRuleFacts(factsDb: FactsDB | null | undefined, limit: number): MemoryEntry[] {
  if (!factsDb) return [];
  try {
    return factsDb.listFactsByCategory("rule", limit);
  } catch {
    return [];
  }
}

async function collectSemanticCandidates(input: {
  queryText: string;
  workspaceRoot: string;
  factsDb?: FactsDB | null;
  embedText?: (text: string) => Promise<number[]>;
  topK: number;
  cacheTtlSeconds: number;
}): Promise<Array<{ source: DedupCandidate["source"]; location: string; id?: string; text: string; similarity: number }>> {
  const queryVector = await cachedEmbed(input.queryText, input.embedText, input.cacheTtlSeconds);
  if (!queryVector) return [];

  const candidates: Array<{
    source: DedupCandidate["source"];
    location: string;
    id?: string;
    text: string;
    similarity: number;
  }> = [];

  for (const fact of listRuleFacts(input.factsDb, 200)) {
    const tags = fact.tags ?? [];
    const factVector = await cachedEmbed(fact.text, input.embedText, input.cacheTtlSeconds);
    if (!factVector) continue;
    const similarity = cosineSimilarity(queryVector, factVector);
    candidates.push({
      source: "memory-fact",
      location: `fact:${fact.id}`,
      id: fact.id,
      text: fact.text,
      similarity,
    });
    void tags;
  }

  for (const { file, text } of readAuthorityFileSections(input.workspaceRoot, AUTHORITY_FILE_TARGETS)) {
    for (const section of splitSubstantiveSections(text)) {
      const sectionVector = await cachedEmbed(section, input.embedText, input.cacheTtlSeconds);
      if (!sectionVector) continue;
      const similarity = cosineSimilarity(queryVector, sectionVector);
      candidates.push({
        source: "file-section",
        location: file,
        text: section,
        similarity,
      });
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, input.topK);
}

function looksContradictory(a: string, b: string): boolean {
  const na = normalizeProposalText(a);
  const nb = normalizeProposalText(b);
  const neverNever = /\bnever\b/i.test(na) && /\bnever\b/i.test(nb);
  const alwaysNever =
    (/\balways\b/i.test(na) && /\bnever\b/i.test(nb)) || (/\bnever\b/i.test(na) && /\balways\b/i.test(nb));
  const preferVsDefault =
    (/\bprefer\b/i.test(na) && /\bdefault\b/i.test(nb)) || (/\bdefault\b/i.test(na) && /\bprefer\b/i.test(nb));
  return neverNever || alwaysNever || preferVsDefault;
}

export async function routePersonaProposal(input: RoutePersonaProposalInput): Promise<PersonaProposalAssessment> {
  const routing = input.routing.enabled ? input.routing : { ...DEFAULT_PERSONA_RULE_ROUTING, enabled: false };
  const body = proposalBody(input);
  const llmConfidenceHint = input.confidence;
  const supportScore = computeSupportScore(input);
  const mutationRisk = computeMutationRisk(input.targetFile, input.suggestedChange);

  const classification = classifyAuthorityBucket(body);
  let recommendedTargetFile = classification.bucket;
  let routingScore = classification.routingScore;
  let routingRationale = classification.rationale;

  if (
    recommendedTargetFile !== "skill_workshop" &&
    recommendedTargetFile !== "memory_fact" &&
    !input.allowedFiles.includes(recommendedTargetFile)
  ) {
    const fallback = input.allowedFiles.includes("USER.md") ? "USER.md" : input.allowedFiles[0];
    if (fallback) {
      recommendedTargetFile = fallback as AuthorityTarget;
      routingScore *= 0.8;
      routingRationale += ` Recommended file not in allowedFiles; softened to ${fallback}.`;
    }
  }

  const evidence: RuleRoutingEvidence[] = [];
  const dedupCandidates: DedupCandidate[] = [];
  const contradictionCandidates: ContradictionCandidate[] = [];
  let dedupScore = 0;
  let contradictionRisk = 0;
  let humanReviewRequired = false;
  let applyAllowed = true;
  let contradiction = false;
  let overallDisposition: PersonaProposalDisposition = "propose";
  let blockReason: PersonaProposalAssessment["blockReason"];
  let blockCandidate: PersonaProposalAssessment["blockCandidate"];

  const crossFileMatch = findCrossFileContentMatch({
    suggestedChange: input.suggestedChange,
    workspaceRoot: input.workspaceRoot,
    excludeFile: input.targetFile,
  });
  if (crossFileMatch) {
    dedupScore = 1;
    personaRuleRoutingMetrics.dedupHits += 1;
    const candidate: DedupCandidate = {
      type: "file-section",
      source: "file-section",
      location: crossFileMatch.file,
      snippet: crossFileMatch.snippet,
      similarity: 1,
      summary: `Content already present in ${crossFileMatch.file}.`,
    };
    dedupCandidates.push(candidate);
    evidence.push(candidate);
    blockReason = "already-in-file";
    blockCandidate = {
      source: "file-section",
      location: crossFileMatch.file,
      snippet: crossFileMatch.snippet,
      similarity: 1,
    };
    overallDisposition = "reject";
  }

  if (routing.enabled && routing.semanticDedup.enabled && input.embedText) {
    const semantic = await collectSemanticCandidates({
      queryText: `${input.title}\n${input.suggestedChange}`,
      workspaceRoot: input.workspaceRoot,
      factsDb: input.factsDb,
      embedText: input.embedText,
      topK: routing.topK,
      cacheTtlSeconds: routing.routingCacheTtlSeconds,
    });
    for (const hit of semantic) {
      if (hit.similarity > dedupScore) dedupScore = hit.similarity;
      if (hit.similarity >= routing.dedupeThreshold) {
        personaRuleRoutingMetrics.dedupHits += 1;
        const candidate: DedupCandidate = {
          type: hit.source === "memory-fact" ? "memory-fact" : "file-section",
          source: hit.source,
          id: hit.id,
          location: hit.location,
          snippet: hit.text.slice(0, 160),
          similarity: hit.similarity,
          summary: `Semantic duplicate (${hit.similarity.toFixed(2)}) in ${hit.location}.`,
        };
        dedupCandidates.push(candidate);
        evidence.push(candidate);
        blockReason = "duplicate-rule";
        blockCandidate = {
          source: hit.source,
          location: hit.location,
          snippet: hit.text.slice(0, 160),
          similarity: hit.similarity,
        };
        overallDisposition = "merge";
      } else if (hit.similarity >= routing.nearDedupeThreshold) {
        const candidate: DedupCandidate = {
          type: hit.source === "memory-fact" ? "memory-fact" : "file-section",
          source: hit.source,
          id: hit.id,
          location: hit.location,
          snippet: hit.text.slice(0, 160),
          similarity: hit.similarity,
          mergeWith: true,
          summary: `Near-duplicate (${hit.similarity.toFixed(2)}) in ${hit.location}.`,
        };
        dedupCandidates.push(candidate);
        evidence.push(candidate);
        if (overallDisposition === "propose") overallDisposition = "merge";
        if (!blockReason) blockReason = "near-duplicate-rule";
      }

      const inSameFamily =
        hit.source === "file-section" &&
        sameBucketFamily(input.targetFile, hit.location) &&
        hit.similarity >= routing.nearDedupeThreshold;
      const inRecommendedFamily =
        recommendedTargetFile !== "skill_workshop" &&
        recommendedTargetFile !== "memory_fact" &&
        hit.source === "file-section" &&
        sameBucketFamily(recommendedTargetFile, hit.location) &&
        hit.similarity >= routing.nearDedupeThreshold;
      if (inSameFamily || inRecommendedFamily) {
        evidence.push({
          type: "file-section",
          location: hit.location,
          similarity: hit.similarity,
          snippet: hit.text.slice(0, 160),
          summary: `Same-bucket semantic overlap with ${hit.location}.`,
        });
      }
    }
  }

  if (routing.enabled && input.embedText) {
    const queryVector = await cachedEmbed(`${input.title}\n${input.suggestedChange}`, input.embedText, routing.routingCacheTtlSeconds);
    if (queryVector) {
      for (const fact of listRuleFacts(input.factsDb, 100)) {
        const factVector = await cachedEmbed(fact.text, input.embedText, routing.routingCacheTtlSeconds);
        if (!factVector) continue;
        const similarity = cosineSimilarity(queryVector, factVector);
        if (similarity < routing.contradictionThreshold || similarity >= routing.dedupeThreshold) continue;
        if (!looksContradictory(input.suggestedChange, fact.text)) continue;

        let adjudication: RuleContradictionAdjudication | null = null;
        if (input.adjudicateContradiction) {
          try {
            adjudication = await input.adjudicateContradiction(input.suggestedChange, fact.text);
          } catch {
            personaRuleRoutingMetrics.contradictionDegraded += 1;
            evidence.push({
              type: "contradiction-degraded",
              summary: "Contradiction adjudication failed; manual review required.",
            });
            humanReviewRequired = true;
            applyAllowed = false;
            contradictionRisk = Math.max(contradictionRisk, 0.75);
            continue;
          }
          if (!adjudication) {
            personaRuleRoutingMetrics.contradictionDegraded += 1;
            evidence.push({
              type: "contradiction-degraded",
              summary: "Contradiction adjudication returned malformed JSON; manual review required.",
            });
            humanReviewRequired = true;
            applyAllowed = false;
            contradictionRisk = Math.max(contradictionRisk, 0.75);
            continue;
          }
        } else {
          adjudication = { decision: "manual_review", reason: "embedding-only contradiction signal" };
        }

        personaRuleRoutingMetrics.contradictionHits += 1;
        contradiction = true;
        contradictionRisk = Math.max(contradictionRisk, similarity);
        humanReviewRequired = true;
        applyAllowed = false;
        if (overallDisposition === "propose") overallDisposition = "manual-review";

        const candidate: ContradictionCandidate = {
          type: "memory-fact",
          id: fact.id,
          existingRuleId: fact.id,
          existingLocation: `fact:${fact.id}`,
          similarity,
          snippet: fact.text.slice(0, 160),
          summary: `Potential contradiction with rule fact ${fact.id}.`,
          decision: adjudication.decision,
          mergedRuleText: adjudication.mergedRuleText ?? null,
        };
        contradictionCandidates.push(candidate);
        evidence.push({
          type: "memory-fact",
          id: fact.id,
          similarity,
          snippet: fact.text.slice(0, 160),
          summary: adjudication.reason || candidate.summary,
        });
      }
    }
  }

  const recommendedFile =
    recommendedTargetFile === "skill_workshop" || recommendedTargetFile === "memory_fact"
      ? recommendedTargetFile
      : recommendedTargetFile;
  const callerTarget = input.targetFile;
  const routingDisagrees =
    recommendedFile !== "skill_workshop" &&
    recommendedFile !== "memory_fact" &&
    recommendedFile !== callerTarget;

  let routingSuggestion: PersonaProposalAssessment["routingSuggestion"];
  const routingConfident = routingScore >= 0.7;
  if (routingDisagrees && routingConfident) {
    personaRuleRoutingMetrics.routingSuggestions += 1;
    routingSuggestion = {
      recommendedTargetFile: String(recommendedFile),
      rationale: routingRationale,
      callerTargetFile: callerTarget,
    };
    if (overallDisposition === "propose") overallDisposition = "retarget";
    humanReviewRequired = true;
  } else if (routingDisagrees) {
    routingSuggestion = {
      recommendedTargetFile: String(recommendedFile),
      rationale: `${routingRationale} (low routing confidence ${routingScore.toFixed(2)}; advisory only)`,
      callerTargetFile: callerTarget,
    };
  }

  if (recommendedTargetFile === "skill_workshop" && callerTarget !== "skill_workshop") {
    humanReviewRequired = true;
    routingSuggestion = {
      recommendedTargetFile: "skill_workshop",
      rationale: routingRationale,
      callerTargetFile: callerTarget,
    };
    if (overallDisposition === "propose") overallDisposition = "retarget";
  }

  if (supportScore < 0.55) {
    overallDisposition = "reject";
    blockReason = blockReason ?? "low-support";
  } else if (supportScore < 0.75 && overallDisposition === "propose") {
    overallDisposition = "manual-review";
    humanReviewRequired = true;
  }

  if (routing.routingMode === "enforce") {
    if (routingDisagrees && routingConfident && blockReason !== "duplicate-rule" && blockReason !== "already-in-file") {
      blockReason = blockReason ?? "enforce-routing";
      overallDisposition = "retarget";
    }
    if (contradiction) {
      overallDisposition = "manual-review";
    }
  }

  if (blockReason === "duplicate-rule" || blockReason === "already-in-file") {
    applyAllowed = false;
    humanReviewRequired = true;
  }
  if (contradiction) {
    applyAllowed = false;
  }

  return {
    supportScore,
    routingScore,
    dedupScore,
    contradictionRisk,
    mutationRisk,
    llmConfidenceHint,
    overallDisposition,
    recommendedTargetFile,
    routingRationale,
    routingSuggestion,
    dedupCandidates,
    contradictionCandidates,
    evidence,
    humanReviewRequired,
    applyAllowed,
    contradiction,
    blockReason,
    blockCandidate,
  };
}

export function resolvePersonaRuleRoutingConfig(
  cfg: { personaRuleRouting?: PersonaRuleRoutingConfig },
): PersonaRuleRoutingConfig {
  return { ...DEFAULT_PERSONA_RULE_ROUTING, ...cfg.personaRuleRouting };
}

export function shouldBlockProposalCreation(
  assessment: PersonaProposalAssessment,
  routingMode: PersonaRuleRoutingConfig["routingMode"],
): boolean {
  if (assessment.blockReason === "duplicate-rule" || assessment.blockReason === "already-in-file") return true;
  if (assessment.blockReason === "low-support") return true;
  if (routingMode === "enforce" && assessment.blockReason === "enforce-routing") return true;
  return false;
}
