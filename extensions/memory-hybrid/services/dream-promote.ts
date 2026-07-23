/**
 * Dream promote controller (#2170) — machine gates + auto-promote / quarantine / shadow.
 *
 * Does not require human review. Global curriculum promotes are conservative by default
 * (provenance required; blast-radius deepens in #2172).
 */

import type { FactsDB } from "../backends/facts-db.js";
import { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import type { DreamingConfig } from "../config/types/dreaming.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import { createTransaction } from "../utils/sqlite-transaction.js";
import { pluginLogger } from "../utils/logger.js";
import {
  type CandidateEntryRecord,
  type GateReport,
  type PromoteResult,
  hashFactContent,
} from "./dream-candidate-ops.js";
import { writeScopeWithinBoundary } from "./dream-permission.js";
import { MemoryConflictError } from "../utils/fact-occ.js";
import { capturePromoteBaseline } from "./dream-outcome-probe.js";
import { buildRunMetricsSummary, dreamRunTag } from "./dream-metrics.js";
import { shouldSteeringIgnore } from "./dream-steering.js";

export type PromoteDreamRunOptions = {
  /** Apply even when shadow=true / autoPromote disabled (CLI escape hatch). */
  force?: boolean;
  cfg?: DreamingConfig;
};

function resolveCfg(cfg?: DreamingConfig): DreamingConfig {
  return cfg ?? structuredClone(DEFAULT_DREAMING_CONFIG);
}

/** Evaluate machine gates for every candidate entry on a dream run. */
export function evaluateDreamGates(store: DreamCandidateStore, dreamRunId: string, cfg?: DreamingConfig): GateReport {
  const dreaming = resolveCfg(cfg);
  const entries = store.listCandidateEntries(dreamRunId);
  const decisions: GateReport["decisions"] = [];

  for (const entry of entries) {
    if (dreaming.autoPromote.requireProvenance) {
      const hasSessions = entry.sessionIds.length > 0;
      const hasRationale = typeof entry.rationale === "string" && entry.rationale.trim().length > 0;
      if (!hasSessions && !hasRationale) {
        decisions.push({
          entryId: entry.id,
          pass: false,
          reason: "missing_provenance",
        });
        store.updateCandidateEntry(entry.id, { status: "gated_block" });
        continue;
      }
    }

    if (dreaming.autoPromote.blockOnContradictionWorsening && entry.payload.contradictionWorsens === true) {
      decisions.push({
        entryId: entry.id,
        pass: false,
        reason: "contradiction_worsens",
      });
      store.updateCandidateEntry(entry.id, { status: "gated_block" });
      continue;
    }

    // Blast-radius / prevalence (#2172).
    const scope = (entry.payload.scope ?? "global") as "session" | "agent" | "user" | "global";
    if (!writeScopeWithinBoundary(scope, dreaming.permissionBoundary)) {
      decisions.push({
        entryId: entry.id,
        pass: false,
        reason: `write_scope_${scope}_exceeds_boundary_${dreaming.permissionBoundary.targetScope}`,
      });
      store.updateCandidateEntry(entry.id, { status: "gated_block" });
      continue;
    }

    // Steering ignore list (#2176).
    if (
      shouldSteeringIgnore(
        String(entry.payload.category ?? ""),
        entry.payload.key ?? null,
        entry.payload.text,
        dreaming.steering,
      )
    ) {
      decisions.push({
        entryId: entry.id,
        pass: false,
        reason: `steering_ignore`,
      });
      store.updateCandidateEntry(entry.id, { status: "gated_block" });
      continue;
    }

    const tierKey =
      scope === "session" || scope === "agent" || scope === "user" || scope === "global" ? scope : "global";
    let tier = dreaming.prevalence[tierKey];
    if (tierKey === "global" && dreaming.prevalence.personalSingleTenant) {
      tier = { ...dreaming.prevalence.user, minAgents: 1 };
    }
    const sessions = Math.max(entry.prevalence?.sessions ?? 0, entry.sessionIds.length);
    const agents = entry.prevalence?.agents ?? (entry.sessionIds.length > 0 ? 1 : 0);
    if (sessions < tier.minSessions || agents < tier.minAgents) {
      decisions.push({
        entryId: entry.id,
        pass: false,
        reason: `prevalence_insufficient_${tierKey}_need_s${tier.minSessions}_a${tier.minAgents}_got_s${sessions}_a${agents}`,
      });
      store.updateCandidateEntry(entry.id, { status: "gated_block" });
      continue;
    }
    const confidence =
      typeof (entry.payload as { confidence?: unknown }).confidence === "number"
        ? (entry.payload as { confidence: number }).confidence
        : undefined;
    if (tier.minConfidence != null && confidence != null && confidence < tier.minConfidence) {
      decisions.push({
        entryId: entry.id,
        pass: false,
        reason: `confidence_below_${tier.minConfidence}`,
      });
      store.updateCandidateEntry(entry.id, { status: "gated_block" });
      continue;
    }

    decisions.push({ entryId: entry.id, pass: true, reason: "ok" });
    store.updateCandidateEntry(entry.id, { status: "gated_ok" });
  }

  const ok = decisions.length > 0 && decisions.every((d) => d.pass);
  const wouldPromote = ok;
  return { ok, decisions, wouldPromote };
}

function applyEntry(
  factsDb: FactsDB,
  entry: CandidateEntryRecord,
  dreamRunId?: string,
): { appliedFactId: string | null; postHash: string | null } {
  const dreamTags = dreamRunId ? [dreamRunTag(dreamRunId)] : [];
  switch (entry.op) {
    case "add":
    case "merge":
    case "boost": {
      const { contradictionWorsens: _c, id: preferredId, ...storeInput } = entry.payload;
      const result = factsDb.storeWithResult({
        ...storeInput,
        text: storeInput.text,
        category: storeInput.category ?? "preference",
        importance: storeInput.importance ?? 0.5,
        source: storeInput.source ?? "dream",
        entity: storeInput.entity ?? null,
        key: storeInput.key ?? null,
        value: storeInput.value ?? null,
        tags: [...(storeInput.tags ?? []), ...dreamTags],
      });
      if (result.skipped) return { appliedFactId: null, postHash: null };
      // preferredId is advisory only — FactsDB assigns UUIDs; reverse plan uses applied id.
      void preferredId;
      return {
        appliedFactId: result.entry.id,
        postHash: hashFactContent(result.entry),
      };
    }
    case "supersede": {
      if (!entry.targetFactId) throw new Error("supersede requires targetFactId");
      const { contradictionWorsens: _c, id: _id, ...storeInput } = entry.payload;
      const result = factsDb.storeWithResult({
        ...storeInput,
        text: storeInput.text,
        category: storeInput.category ?? "preference",
        importance: storeInput.importance ?? 0.5,
        source: storeInput.source ?? "dream",
        entity: storeInput.entity ?? null,
        key: storeInput.key ?? null,
        value: storeInput.value ?? null,
        supersedesId: entry.targetFactId,
        tags: [...(storeInput.tags ?? []), ...dreamTags],
      });
      if (result.skipped) return { appliedFactId: null, postHash: null };
      // Per-fact OCC (#2175): use candidate preHash from propose time, never live token.
      const expectedHash = entry.preHash ?? undefined;
      factsDb.supersede(entry.targetFactId, result.entry.id, expectedHash ? { expectedHash } : undefined);
      return {
        appliedFactId: result.entry.id,
        postHash: hashFactContent(result.entry),
      };
    }
    case "delete": {
      if (!entry.targetFactId) throw new Error("delete requires targetFactId");
      const expectedHash = entry.preHash ?? undefined;
      factsDb.supersede(entry.targetFactId, null, expectedHash ? { expectedHash } : undefined);
      return { appliedFactId: entry.targetFactId, postHash: null };
    }
    default:
      throw new Error(`unsupported candidate op: ${entry.op}`);
  }
}

/**
 * Promote a dream run: evaluate gates, then either shadow-log, quarantine, or apply.
 */
export function promoteDreamRun(
  factsDb: FactsDB,
  store: DreamCandidateStore,
  dreamRunId: string,
  options: PromoteDreamRunOptions = {},
): PromoteResult {
  const dreaming = resolveCfg(options.cfg);
  const run = store.getDreamRun(dreamRunId);
  if (!run) {
    return {
      applied: false,
      shadow: true,
      status: "failed",
      gateReport: { ok: false, decisions: [], wouldPromote: false, reason: "run_not_found" },
      appliedFactIds: [],
      error: `dream run not found: ${dreamRunId}`,
    };
  }

  if (run.status === "promoted") {
    return {
      applied: true,
      shadow: run.shadow,
      status: "promoted",
      gateReport: { ok: true, decisions: [], wouldPromote: true, reason: "already_promoted" },
      appliedFactIds: store
        .listCandidateEntries(dreamRunId)
        .map((e) => e.appliedFactId)
        .filter((id): id is string => Boolean(id)),
    };
  }

  if (run.status !== "pending" && run.status !== "running" && run.status !== "gated") {
    return {
      applied: false,
      shadow: run.shadow,
      status: run.status,
      gateReport: { ok: false, decisions: [], wouldPromote: false, reason: `invalid_status_${run.status}` },
      appliedFactIds: [],
      error: `cannot promote dream run in status ${run.status}`,
    };
  }

  if (run.status === "pending") {
    store.updateDreamRunStatus(dreamRunId, "running");
  }

  // OCC: refuse if live store drifted since dream snapshot (#2175).
  const currentRevision = factsDb.computeStoreRevision();
  if (currentRevision !== run.inputStoreRevision && !options.force) {
    store.updateDreamRunStatus(dreamRunId, "failed", {
      failureReason: "stale_input_store_revision",
      gateReportJson: JSON.stringify({ ok: false, reason: "stale_input_store_revision" }),
    });
    return {
      applied: false,
      shadow: run.shadow,
      status: "failed",
      gateReport: { ok: false, decisions: [], wouldPromote: false, reason: "stale_input_store_revision" },
      appliedFactIds: [],
      error: "input_store_revision mismatch — re-run dream or pass force",
    };
  }

  const gateReport = evaluateDreamGates(store, dreamRunId, dreaming);
  store.updateDreamRunStatus(dreamRunId, "gated", {
    gateReportJson: JSON.stringify(gateReport),
  });

  if (!gateReport.ok) {
    store.updateDreamRunStatus(dreamRunId, "quarantined", {
      failureReason: "gate_reject",
      gateReportJson: JSON.stringify(gateReport),
    });
    return {
      applied: false,
      shadow: run.shadow,
      status: "quarantined",
      gateReport,
      appliedFactIds: [],
    };
  }

  const shadowOnly = run.shadow || !dreaming.autoPromote.enabled;
  if (shadowOnly && !options.force) {
    pluginLogger.info?.(
      `memory-hybrid: dream ${dreamRunId} gated OK (wouldPromote) — shadow/autoPromote off; not applying`,
    );
    return {
      applied: false,
      shadow: true,
      status: "gated",
      gateReport: { ...gateReport, wouldPromote: true },
      appliedFactIds: [],
    };
  }

  const appliedFactIds: string[] = [];
  try {
    const tx = createTransaction(
      factsDb.getRawDb(),
      () => {
        const entries = store
          .listCandidateEntries(dreamRunId)
          .filter((e) => e.status === "gated_ok")
          .sort((a, b) => a.sortOrder - b.sortOrder);
        for (const entry of entries) {
          try {
            const { appliedFactId, postHash } = applyEntry(factsDb, entry, dreamRunId);
            store.updateCandidateEntry(entry.id, {
              status: "applied",
              appliedFactId,
              postHash,
              reverse:
                entry.op === "add" || entry.op === "merge" || entry.op === "boost"
                  ? { op: "delete_fact", payload: { factId: appliedFactId } }
                  : entry.op === "supersede"
                    ? {
                        op: "unsupersede",
                        payload: {
                          oldFactId: entry.targetFactId,
                          newFactId: appliedFactId,
                        },
                      }
                    : entry.op === "delete"
                      ? {
                          op: "unsupersede",
                          payload: { oldFactId: entry.targetFactId, newFactId: null },
                        }
                      : entry.reverse,
            });
            if (appliedFactId) {
              appliedFactIds.push(appliedFactId);
              try {
                factsDb.addTag(appliedFactId, dreamRunTag(dreamRunId));
              } catch {
                // Best-effort attribution tag (#2173).
              }
            }
          } catch (err) {
            if (err instanceof MemoryConflictError) {
              store.updateCandidateEntry(entry.id, { status: "gated_block" });
              throw err;
            }
            throw err;
          }
        }
      },
      "IMMEDIATE",
    );
    tx();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof MemoryConflictError ? "failed" : "failed";
    store.updateDreamRunStatus(dreamRunId, status, { failureReason: message });
    return {
      applied: false,
      shadow: false,
      status: "failed",
      gateReport,
      appliedFactIds: [],
      error: message,
    };
  }

  const observeUntil = dreaming.autoRollback.enabled
    ? Math.floor(Date.now() / 1000) + dreaming.autoRollback.observeWindowHours * 3600
    : null;

  const promotedAt = Math.floor(Date.now() / 1000);
  const baselineJson = capturePromoteBaseline(factsDb, run.sessionIds, promotedAt);
  const metricsSummary = buildRunMetricsSummary(factsDb, {
    sessionIds: run.sessionIds,
    startedAt: run.startedAt,
    endedAt: promotedAt,
  });

  store.updateDreamRunStatus(dreamRunId, "promoted", {
    metricsBaselineJson: baselineJson,
    metricsObserveUntil: observeUntil,
    metricsSummaryJson: JSON.stringify(metricsSummary),
    gateReportJson: JSON.stringify({
      ...gateReport,
      structuralSnapshot: { factCount: factsDb.count(), at: promotedAt },
    }),
  });

  return {
    applied: true,
    shadow: false,
    status: "promoted",
    gateReport,
    appliedFactIds,
  };
}

export function quarantineDreamRun(store: DreamCandidateStore, dreamRunId: string, reason: string): void {
  store.updateDreamRunStatus(dreamRunId, "quarantined", { failureReason: reason });
}
