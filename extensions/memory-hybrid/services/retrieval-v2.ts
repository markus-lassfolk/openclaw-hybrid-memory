/**
 * Retrieval v2 post-processing pipeline (Issue #1910).
 * Applies BM25 bypass decision, composite scoring, diversity, and structured logging.
 */

import type OpenAI from "openai";
import type { SearchResult } from "../types/memory.js";
import type { MemoryEntry } from "../types/memory.js";
import { applyDiversityDemotion, type DiversityConfig } from "./diversity.js";
import {
  computeCompositeScore,
  computeFrequencyBoost,
  recencyScoreFromDays,
  type CompositeScoreConfig,
} from "./composite-score.js";
import {
  classifyQueryIntent,
  type IntentClassification,
  type IntentClassifierConfig,
  type QueryIntent,
} from "./intent-classifier.js";
import { emitRecallVerboseLog, isHmVerbose } from "./recall-verbose-log.js";
import { recordRecallStageTiming, recordBypassDecision } from "./recall-timing-stats.js";
import { computeCrossDomainBoost, aggregateRecallStats } from "./recall-signals.js";

export type BypassConfig = {
  enabled: boolean;
  bm25MinScore: number;
  bm25MinGap: number;
};

export const DEFAULT_BYPASS_CONFIG: BypassConfig = {
  enabled: false,
  bm25MinScore: 0.85,
  bm25MinGap: 0.15,
};

export type RetrievalV2Config = {
  intentRouter: IntentClassifierConfig;
  compositeScore: CompositeScoreConfig;
  diversity: DiversityConfig;
  bypass: BypassConfig;
};

export const DEFAULT_RETRIEVAL_V2_CONFIG: RetrievalV2Config = {
  intentRouter: { enabled: true, llmRefinement: false, heuristicThreshold: 0.8 },
  compositeScore: { version: 1, pinBoostDefault: 0.3, pinBoostCap: 1.0 },
  diversity: { enabled: false, maxSimilarity: 0.6 },
  bypass: DEFAULT_BYPASS_CONFIG,
};

export type Bm25BypassDecision = {
  bypass: boolean;
  topScore: number;
  gap: number;
};

/** Evaluate strong-signal BM25 bypass from FTS scores. */
export function evaluateBm25Bypass(
  ftsResults: SearchResult[],
  config: BypassConfig,
  hasExplicitIntent: boolean,
): Bm25BypassDecision {
  const sorted = [...ftsResults].sort((a, b) => b.score - a.score);
  const top = sorted[0]?.score ?? 0;
  const second = sorted[1]?.score ?? 0;
  const gap = top - second;
  const bypass = config.enabled && !hasExplicitIntent && top >= config.bm25MinScore && gap >= config.bm25MinGap;
  return { bypass, topScore: top, gap };
}

export type ApplyRetrievalV2Opts = {
  query: string;
  results: SearchResult[];
  ftsResults: SearchResult[];
  getEntry: (id: string) => MemoryEntry | null;
  config: RetrievalV2Config;
  recallId: string;
  sessionId?: string;
  openai?: OpenAI;
  explicitIntent?: QueryIntent;
  nowSec?: number;
  focusTopic?: string;
  factsDb?: { getRawDb(): import("node:sqlite").DatabaseSync };
  /** When false, skip bypass telemetry (pipeline probe already recorded). */
  recordBypassTelemetry?: boolean;
};

export type RetrievalV2Outcome = {
  results: SearchResult[];
  intent: IntentClassification;
  bypassed: boolean;
  mmrDemoted: number;
  top3ChangedVsV1: boolean;
};

function topicMatchMultiplier(text: string, focusTopic?: string): number {
  if (!focusTopic?.trim()) return 1;
  const topic = focusTopic.trim().toLowerCase();
  const lower = text.toLowerCase();
  if (lower.includes(topic)) return 1.4;
  return 0.75;
}

/** Apply retrieval v2 scoring and diversity to merged results. */
export async function applyRetrievalV2(opts: ApplyRetrievalV2Opts): Promise<RetrievalV2Outcome> {
  const t0 = Date.now();
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);

  const intentStarted = Date.now();
  const intent = await classifyQueryIntent(opts.query, opts.config.intentRouter, {
    explicitIntent: opts.explicitIntent,
    sessionId: opts.sessionId,
    openai: opts.openai,
  });
  recordRecallStageTiming("intent", Date.now() - intentStarted);

  const bypassDecision = evaluateBm25Bypass(opts.ftsResults, opts.config.bypass, intent.source === "explicit");
  recordRecallStageTiming("bypass_decision", 0);
  if (opts.recordBypassTelemetry !== false) {
    recordBypassDecision(bypassDecision.bypass);
  }

  const v1Order = opts.results.map((r) => r.entry.id);
  const compositeCfg = opts.config.compositeScore;
  const recallStats =
    opts.factsDb && compositeCfg.version === 2
      ? aggregateRecallStats(opts.factsDb.getRawDb(), 30)
      : null;
  let finalResults: SearchResult[];
  let demotedCount = 0;

  const scored = opts.results.map((r) => {
    const entry = opts.getEntry(r.entry.id) ?? r.entry;
    const daysSince = entry.lastAccessed != null ? (nowSec - entry.lastAccessed) / 86_400 : 0;
    const input = {
      searchScore: r.score,
      recencyScore: recencyScoreFromDays(daysSince),
      confidence: entry.confidence ?? 1,
      bodyLength: entry.text.length,
      qualityScore: (entry as MemoryEntry & { qualityScore?: number }).qualityScore,
      coActivationBoost: 1,
      pinBoost: entry.pinnedAt != null ? compositeCfg.pinBoostDefault : 0,
      freqBoost: computeFrequencyBoost(
        (entry as MemoryEntry & { revisionCount?: number }).revisionCount ?? 0,
        (entry as MemoryEntry & { duplicateCount?: number }).duplicateCount ?? 0,
      ),
      crossDomainBoost: recallStats
        ? computeCrossDomainBoost(recallStats.get(r.entry.id)?.distinctQueries ?? 0, 3)
        : 0,
      intent: intent.intent,
      focusMultiplier: topicMatchMultiplier(entry.text, opts.focusTopic),
    };
    const v2 = computeCompositeScore(input, { ...compositeCfg, version: 2 });
    const v1 = computeCompositeScore(input, { ...compositeCfg, version: 1 });
    const useScore = compositeCfg.version === 2 ? v2 : v1;
    return { result: r, score: useScore, text: entry.text, v1, v2 };
  });

  scored.sort((a, b) => b.score - a.score);
  const diversityStarted = Date.now();
  const { items: diverseItems, demotedCount: dmCount } = applyDiversityDemotion(
    scored.map((s) => ({ text: s.text, ...s })),
    opts.config.diversity,
  );
  recordRecallStageTiming("mmr", Date.now() - diversityStarted);
  demotedCount = dmCount;

  finalResults = diverseItems.map((s) => ({ ...s.result, score: s.score }));
  const v2Order = finalResults.map((r) => r.entry.id);
  const top3Changed = v1Order.slice(0, 3).join() !== v2Order.slice(0, 3).join() && compositeCfg.version === 2;

  if (isHmVerbose()) {
    emitRecallVerboseLog({
      evt: "recall.summary",
      feature: "retrieval_v2",
      recall_id: opts.recallId,
      session_id: opts.sessionId,
      intent: intent.intent,
      confidence: intent.confidence,
      intent_source: intent.source,
      bypassed: bypassDecision.bypass,
      candidates_in: opts.results.length,
      candidates_out: finalResults.length,
      mmr_demoted: demotedCount,
      top3_changed_vs_v1: top3Changed,
      latency_ms: Date.now() - t0,
    });
  }

  return {
    results: finalResults,
    intent,
    bypassed: bypassDecision.bypass,
    mmrDemoted: demotedCount,
    top3ChangedVsV1: top3Changed,
  };
}
