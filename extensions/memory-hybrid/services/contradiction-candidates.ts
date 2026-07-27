/**
 * Free-text contradiction candidates (LIVING-MEMORY.md deferred item B1, nightly).
 *
 * The structured detector (`detectContradictions`) only catches exact entity+key collisions —
 * "user prefers tabs" vs "user prefers spaces" written as free text sails past it. This pass
 * closes that gap without touching the hot path: recent facts → vector top-k in-scope neighbors
 * (cosine floor, converted to the vector store's 1/(1+L2) score space) → local-LLM NLI verdict →
 * `recordContradiction` with the `nli_free_text` audit marker. Recorded pairs flow into the
 * existing nightly resolve pass and the Memory Graph conflicts panel like any other contradiction.
 */
import type { DatabaseSync } from "node:sqlite";
import type OpenAI from "openai";
import { contradictionPairExists, recordContradiction } from "../backends/facts-db/contradictions.js";
import type { MemoryLinkType } from "../backends/facts-db/types.js";
import type { MemoryEntry, SearchResult } from "../types/memory.js";
import { maintenanceRunDeadlineReached } from "../utils/maintenance-run-deadline.js";
import { classifyLlmFailureClass } from "./chat.js";
import { adjudicateNliContradiction } from "./contradiction-adjudicator.js";
import { capturePluginError } from "./error-reporter.js";

export interface ContradictionCandidatesDeps {
  factsDb: {
    getById(id: string): MemoryEntry | null;
    createLink(a: string, b: string, t: MemoryLinkType, s?: number): string;
    getRawDb(): DatabaseSync;
  };
  vectorDb: { search(vector: number[], limit?: number, minScore?: number): Promise<SearchResult[]> };
  embeddings: { embed(text: string): Promise<number[]> };
  openai: OpenAI;
}

export interface ContradictionCandidatesConfig {
  /** Cosine similarity floor for neighbor pairs (converted to vector-score space internally). */
  similarityFloor: number;
  /** Hard cap on NLI LLM calls per run. */
  maxPairsPerRun: number;
  /** Minimum NLI confidence to record a contradiction. */
  minConfidence: number;
  model: string;
  fallbackModels: string[];
}

export interface ContradictionCandidatesResult {
  scanned: number;
  pairsConsidered: number;
  llmCalls: number;
  recorded: number;
  skippedExisting: number;
  skippedStructured: number;
  /** Pairs the LLM adjudicated as not a contradiction (or below minConfidence) — a healthy outcome,
   *  not a failure. Distinguishing this from `llmFailures` lets operators tell "the LLM said these
   *  aren't contradictions" from "the LLM was flaky/erroring" when `recorded` is 0. */
  rejectedByLlm: number;
  /** NLI calls that threw (transport/provider error or malformed-JSON parse failure). */
  llmFailures: number;
  semanticOutcome: "success" | "partial" | "deferred";
}

/** VectorDB score = 1/(1+L2); for normalized vectors L2 = sqrt(2·(1−cosine)). */
export function cosineToVectorScore(cosine: number): number {
  return 1 / (1 + Math.sqrt(2 * (1 - Math.min(1, Math.max(-1, cosine)))));
}

/** Above this vector score the pair is a near-duplicate — consolidation's job, not a contradiction. */
const NEAR_DUP_COSINE = 0.98;

export async function runContradictionCandidates(
  deps: ContradictionCandidatesDeps,
  cfg: ContradictionCandidatesConfig,
  opts: { dryRun?: boolean; sinceHours?: number; nowSec?: number; verbose?: boolean },
  logger: { info(m: string): void; warn(m: string): void },
): Promise<ContradictionCandidatesResult> {
  const result: ContradictionCandidatesResult = {
    scanned: 0,
    pairsConsidered: 0,
    llmCalls: 0,
    recorded: 0,
    skippedExisting: 0,
    skippedStructured: 0,
    rejectedByLlm: 0,
    llmFailures: 0,
    semanticOutcome: "success",
  };
  if (maintenanceRunDeadlineReached()) {
    return { ...result, semanticOutcome: "deferred" };
  }

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - (opts.sinceHours ?? 48) * 3600;
  const db = deps.factsDb.getRawDb();
  const recent = db
    .prepare(
      `SELECT id FROM facts
        WHERE created_at >= ? AND superseded_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
          AND length(text) >= 30
        ORDER BY created_at DESC LIMIT 100`,
    )
    .all(sinceSec, nowSec) as Array<{ id: string }>;
  result.scanned = recent.length;
  if (recent.length === 0) return result;

  const minScore = cosineToVectorScore(cfg.similarityFloor);
  const nearDupScore = cosineToVectorScore(NEAR_DUP_COSINE);
  const seenPairs = new Set<string>();
  let llmFailures = 0;
  let embedFailures = 0;
  let deadlineHit = false;

  for (const row of recent) {
    if (maintenanceRunDeadlineReached()) {
      deadlineHit = true;
      break;
    }
    if (result.llmCalls >= cfg.maxPairsPerRun) break;
    const fact = deps.factsDb.getById(row.id);
    if (!fact || fact.supersededAt) continue;

    let neighbors: SearchResult[];
    try {
      const vector = await deps.embeddings.embed(fact.text);
      neighbors = await deps.vectorDb.search(vector, 6, minScore);
    } catch (err) {
      embedFailures++;
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "contradiction-candidates-embed",
        subsystem: "embeddings",
      });
      if (embedFailures >= 5) {
        logger.warn("memory-hybrid: contradiction-candidates — repeated embedding failures; stopping this run");
        return { ...result, semanticOutcome: "partial" };
      }
      continue; // this one fact's neighbor lookup failed → the h44 guard retries next run
    }

    for (const neighbor of neighbors) {
      if (result.llmCalls >= cfg.maxPairsPerRun) break;
      const other = neighbor.entry.id === fact.id ? null : deps.factsDb.getById(neighbor.entry.id);
      if (!other || other.supersededAt) continue;
      // In-scope only: cross-scope "contradictions" are usually just different contexts.
      if ((fact.scope ?? "global") !== (other.scope ?? "global")) continue;
      if ((fact.scopeTarget ?? null) !== (other.scopeTarget ?? null)) continue;
      // Near-duplicates repel: same thought is consolidation's territory.
      if (neighbor.score >= nearDupScore) continue;
      // Structured entity+key collisions are detectContradictions' territory — skip so one pair
      // never gets recorded by two different detectors with different evidence.
      if (
        fact.entity &&
        fact.key &&
        fact.entity.toLowerCase() === (other.entity ?? "").toLowerCase() &&
        fact.key.toLowerCase() === (other.key ?? "").toLowerCase()
      ) {
        result.skippedStructured++;
        continue;
      }
      const pairKey = [fact.id, other.id].sort().join(" ");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      if (contradictionPairExists(db, fact.id, other.id)) {
        result.skippedExisting++;
        continue;
      }

      result.pairsConsidered++;
      const newer = fact.createdAt >= other.createdAt ? fact : other;
      const older = newer === fact ? other : fact;
      result.llmCalls++;
      try {
        const verdict = await adjudicateNliContradiction(
          deps.openai,
          cfg.model,
          { newerText: newer.text, olderText: older.text },
          cfg.fallbackModels,
        );
        if (verdict.verdict !== "contradiction" || verdict.confidence < cfg.minConfidence) {
          result.rejectedByLlm++;
          if (opts.verbose) {
            logger.info(
              `memory-hybrid: contradiction-candidates — rejected ${newer.id} vs ${older.id} (verdict=${verdict.verdict}, conf ${verdict.confidence.toFixed(2)})`,
            );
          }
          continue;
        }
        if (opts.dryRun) {
          result.recorded++;
          continue;
        }
        recordContradiction(db, newer.id, older.id, (a, b, t, s) => deps.factsDb.createLink(a, b, t, s ?? 1.0), {
          score: verdict.confidence,
          heuristicSignals: ["nli_free_text"],
        });
        result.recorded++;
        if (opts.verbose) {
          logger.info(
            `memory-hybrid: contradiction-candidates — recorded ${newer.id} vs ${older.id} (conf ${verdict.confidence.toFixed(2)}: ${verdict.reason.slice(0, 120)})`,
          );
        }
      } catch (err) {
        llmFailures++;
        result.llmFailures++;
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "contradiction-nli",
          subsystem: "openai",
          tags: { llm_failure_class: classifyLlmFailureClass(err) },
        });
        if (llmFailures >= 3) {
          logger.warn(
            `memory-hybrid: contradiction-candidates — repeated NLI failures; stopping this run (last failure class=${classifyLlmFailureClass(err)})`,
          );
          return { ...result, semanticOutcome: "partial" };
        }
      }
    }
  }

  // NOT `llmCalls < pairsConsidered` — the two counters are always incremented together in
  // lockstep a few lines above, so that comparison could never be true and this check never
  // fired. `deadlineHit` (set where the outer loop actually breaks on the deadline) is the real
  // signal that some of tonight's `recent` facts were never scanned.
  if (deadlineHit || maintenanceRunDeadlineReached()) {
    result.semanticOutcome = "partial";
  }
  return result;
}
