/**
 * Serendipity Level-4 sweep (Issue #2119) — opt-in scheduled revisit of the
 * deferred backlog. Config-safe and idempotent: it prunes expired findings and
 * builds a backlog digest. It never edits code; when `sweep.dispatch` is off
 * (the default) it only reports. Even with dispatch on it surfaces candidates
 * for the agent to act on under the normal approval rules — it does not spawn
 * autonomous work here.
 */

import type { HybridMemoryConfig } from "../config.js";
import type { SerendipityStore } from "../backends/serendipity-store.js";
import type { SerendipityScopeContext } from "../types/serendipity-types.js";
import { nowIso } from "../utils/dates.js";
import { buildSerendipityDigestReport, type SerendipityDigestReport } from "./serendipity-digest.js";

export interface SerendipitySweepCandidate {
  id: string;
  title: string;
  findingType: string;
  suggestedAction: string;
  riskLevel: string;
}

export interface SerendipitySweepSummary {
  runId: string;
  generatedAt: string;
  status: "ok" | "skipped";
  skipReason?: string;
  level: number;
  minLevel: number;
  dispatch: boolean;
  prunedExpired: number;
  actionable: number;
  /** Top items the agent could pick up (only populated when dispatch is enabled). */
  dispatchCandidates: SerendipitySweepCandidate[];
  digest?: SerendipityDigestReport;
}

export interface RunSerendipitySweepOptions {
  cfg: HybridMemoryConfig;
  store: SerendipityStore | null;
  /** Scope used to resolve the effective engagement level (defaults to global). */
  scope?: SerendipityScopeContext;
  runId?: string;
  sinceDays?: number;
  /** Max dispatch candidates to surface (default 5). */
  maxCandidates?: number;
}

export function runSerendipitySweep(opts: RunSerendipitySweepOptions): SerendipitySweepSummary {
  const sp = opts.cfg.serendipityProtocol;
  const runId = opts.runId ?? `serendipity-sweep-${nowIso()}`;
  const base: SerendipitySweepSummary = {
    runId,
    generatedAt: nowIso(),
    status: "skipped",
    level: 0,
    minLevel: sp.sweep.minLevel,
    dispatch: sp.sweep.dispatch,
    prunedExpired: 0,
    actionable: 0,
    dispatchCandidates: [],
  };

  if (!sp.enabled) return { ...base, skipReason: "serendipity_disabled" };
  if (!opts.store) return { ...base, skipReason: "store_unavailable" };
  if (!sp.sweep.enabled) return { ...base, skipReason: "sweep_disabled" };

  const level = opts.store.resolveLevel(opts.scope ?? {}, sp.defaultLevel);
  if (level < sp.sweep.minLevel) {
    return { ...base, level, skipReason: "below_min_level" };
  }

  // Idempotent: prune expired backlog, then report. Safe to run concurrently.
  const prunedExpired = opts.store.archiveExpired();
  const sinceDays = opts.sinceDays ?? 30;
  const digest = buildSerendipityDigestReport({ store: opts.store, sinceDays, level });
  const maxCandidates = opts.maxCandidates ?? 5;
  const dispatchCandidates: SerendipitySweepCandidate[] = sp.sweep.dispatch
    ? digest.backlog.top.slice(0, maxCandidates).map((e) => ({
        id: e.id,
        title: e.title,
        findingType: e.findingType,
        suggestedAction: e.suggestedAction,
        riskLevel: e.riskLevel,
      }))
    : [];

  return {
    ...base,
    status: "ok",
    level,
    prunedExpired,
    actionable: digest.backlog.actionable,
    dispatchCandidates,
    digest,
  };
}

/** One-line operator summary for logs / cron stdout. */
export function renderSerendipitySweepSummary(summary: SerendipitySweepSummary): string {
  if (summary.status === "skipped") {
    return `Serendipity sweep ${summary.runId}: skipped (${summary.skipReason ?? "unknown"}).`;
  }
  const dispatched = summary.dispatch ? `, ${summary.dispatchCandidates.length} dispatch candidate(s)` : "";
  return `Serendipity sweep ${summary.runId}: level ${summary.level}, ${summary.actionable} actionable, pruned ${summary.prunedExpired} expired${dispatched}.`;
}
