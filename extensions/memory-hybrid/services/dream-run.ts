/**
 * Unified Dream product operation (#2171 / Epic #2169).
 *
 * Composes existing maintenance steps behind one transaction-shaped facade:
 * snapshot revision → run compose stages → emit candidates → optional promote.
 *
 * Does not delete nightly CLIs; when `dreaming.skipNightlyOverlap` is true the
 * maintenance orchestrator skips overlapping steps (see maintenance-orchestrator).
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import type { DreamComposeStep, DreamingConfig } from "../config/types/dreaming.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import type { DreamSteeringConfig } from "../config/types/dreaming.js";
import {
  clearMaintenanceRunDeadline,
  maintenanceRunDeadlineReached,
  setMaintenanceRunDeadlineMs,
} from "../utils/maintenance-run-deadline.js";
import { pluginLogger } from "../utils/logger.js";
import { withCostFeature } from "./cost-context.js";
import { CostFeature } from "./cost-feature-labels.js";
import type {
  CandidateEntryInput,
  CandidateEntryRecord,
  DreamRunRecord,
  PromoteResult,
} from "./dream-candidate-ops.js";
import { promoteDreamRun } from "./dream-promote.js";
import { buildRunMetricsSummary } from "./dream-metrics.js";
import { resolveSteering } from "./dream-steering.js";

export type DreamStepSummary = {
  step: DreamComposeStep;
  ok: boolean;
  detail: string;
  skipped?: boolean;
};

export type DreamStepRunner = (ctx: {
  dreamRunId: string;
  sessionIds: string[];
  steeringPolicyId: string | null;
  steering: DreamSteeringConfig;
  /** When false, runners must not mutate FactsDB (shadow / candidate-only). */
  dryRun: boolean;
  abortSignal?: AbortSignal;
}) => Promise<{ detail: string; candidates?: CandidateEntryInput[] }>;

export type DreamStepRunners = Partial<Record<DreamComposeStep, DreamStepRunner>>;

export type RunDreamOptions = {
  factsDb: FactsDB;
  store: DreamCandidateStore;
  cfg?: DreamingConfig;
  sessionIds?: string[];
  steeringPolicyId?: string | null;
  /** Inject existing CLI/service bindings — do not reimplement steps here. */
  steps?: DreamStepRunners;
  /**
   * When true, call promoteDreamRun after candidates are written.
   * Default: dreaming.autoPromote.enabled OR promoteAfterRun.
   */
  promote?: boolean;
  /** Force promote apply even under shadow (escape hatch). */
  forcePromote?: boolean;
  /** Wall-clock ceiling override (minutes). */
  maxRuntimeMinutes?: number;
  dryShadow?: boolean;
  /**
   * When true, compose runners may mutate the live store (legacy). Default false when
   * candidateStore/shadow is on — compose must emit candidates without live writes (#2170/#2171).
   */
  liveMutateCompose?: boolean;
  /** Sessions excluded by permission boundary — persisted on run metrics (#2174). */
  excludedSessions?: Array<{ sessionId: string; reason: string }>;
};

export type RunDreamResult = {
  dreamRunId: string;
  run: DreamRunRecord;
  candidates: CandidateEntryRecord[];
  stepSummaries: DreamStepSummary[];
  promoteResult?: PromoteResult;
  timedOut: boolean;
  costFeature: typeof CostFeature.dream;
};

const COMPOSE_ORDER: readonly DreamComposeStep[] = [
  "distill",
  "self-correction",
  "contradictions",
  "reflect",
  "consolidate",
  "dream-cycle-core",
];

function resolveCompose(cfg: DreamingConfig): DreamComposeStep[] {
  const requested = cfg.compose.length > 0 ? cfg.compose : DEFAULT_DREAMING_CONFIG.compose;
  const seen = new Set<DreamComposeStep>();
  const ordered: DreamComposeStep[] = [];
  for (const step of COMPOSE_ORDER) {
    if (requested.includes(step) && !seen.has(step)) {
      seen.add(step);
      ordered.push(step);
    }
  }
  // Preserve any unknown-order extras (should not happen with typed config).
  for (const step of requested) {
    if (!seen.has(step)) {
      seen.add(step);
      ordered.push(step);
    }
  }
  // Mutual exclusion: dream-cycle-core embeds reflect — drop reflect when both requested.
  if (ordered.includes("dream-cycle-core") && ordered.includes("reflect")) {
    return ordered.filter((s) => s !== "reflect");
  }
  return ordered;
}

function boundSessionIds(sessionIds: string[] | undefined, maxSessions: number): string[] {
  if (!sessionIds || sessionIds.length === 0) return [];
  const capped = Math.max(1, Math.min(100, Math.floor(maxSessions)));
  return sessionIds.slice(0, capped);
}

function curriculumCandidate(input: {
  dreamRunId: string;
  sessionIds: string[];
  stepSummaries: DreamStepSummary[];
  compose: DreamComposeStep[];
}): CandidateEntryInput {
  const okSteps = input.stepSummaries.filter((s) => s.ok && !s.skipped).map((s) => s.step);
  const detailLines = input.stepSummaries.map(
    (s) => `${s.step}:${s.skipped ? "skipped" : s.ok ? "ok" : "fail"}:${s.detail}`,
  );
  const text = [
    `Dream curriculum update (${input.dreamRunId})`,
    `compose=[${input.compose.join(",")}]`,
    `completed=[${okSteps.join(",") || "none"}]`,
    ...detailLines.slice(0, 12),
  ].join("\n");

  return {
    op: "add",
    payload: {
      text,
      category: "preference",
      importance: 0.4,
      source: "dream",
      entity: "dream",
      key: "curriculum_summary",
      value: input.dreamRunId,
      // Prefer low blast-radius for the synthetic summary (#2172); real insights carry their own scope.
      scope: input.sessionIds.length > 0 ? "session" : "agent",
      scopeTarget: input.sessionIds[0] ?? "dream",
    },
    evidence: {
      sessionIds: input.sessionIds,
      prevalence: {
        sessions: input.sessionIds.length,
        agents: input.sessionIds.length > 0 ? 1 : 0,
      },
      rationale: `Unified Dream (#2171) completed compose stages: ${okSteps.join(", ") || "none"}`,
    },
    reverse: { op: "delete_fact", payload: {} },
    sortOrder: 0,
  };
}

/**
 * Run the unified Dream pipeline. Always creates a dream_run and ≥1 candidate
 * (even when promote is disabled / shadow-only).
 */
export async function runDream(options: RunDreamOptions): Promise<RunDreamResult> {
  const cfg = options.cfg ?? DEFAULT_DREAMING_CONFIG;
  const { factsDb, store } = options;

  if (!cfg.enabled && options.promote !== true && options.forcePromote !== true) {
    // Still allow explicit CLI invocation; only block unsolicited auto paths.
  }

  const sessionIds = boundSessionIds(options.sessionIds, cfg.maxSessions);
  const compose = resolveCompose(cfg);
  const steering = resolveSteering(cfg.steering);
  const shadow = options.dryShadow === true ? true : cfg.candidateStore.shadow !== false || !cfg.autoPromote.enabled;

  // Candidate/shadow path must not mutate live store during compose (#2170).
  const liveMutateCompose =
    options.liveMutateCompose === true && !shadow && options.dryShadow !== true && cfg.candidateStore.enabled !== true;

  const maxMinutes = options.maxRuntimeMinutes ?? cfg.maxRuntimeMinutes;
  const deadlineMs = Date.now() + Math.max(1, maxMinutes) * 60_000;
  setMaintenanceRunDeadlineMs(deadlineMs);

  return withCostFeature(CostFeature.dream, async () => {
    const run = store.createDreamRun({
      inputStoreRevision: factsDb.computeStoreRevision(),
      sessionIds,
      steeringPolicyId: options.steeringPolicyId ?? steering.profile,
      shadow,
    });
    store.updateDreamRunStatus(run.id, "running");
    store.setDreamRunMetrics(run.id, {
      metricsSummaryJson: JSON.stringify({
        steering: {
          profile: steering.profile,
          promote: steering.promote,
          ignore: steering.ignore,
          notes: steering.notes ?? null,
        },
        recordedAt: Math.floor(Date.now() / 1000),
      }),
    });

    const stepSummaries: DreamStepSummary[] = [];
    const collectedCandidates: CandidateEntryInput[] = [];
    let timedOut = false;

    try {
      for (const step of compose) {
        if (maintenanceRunDeadlineReached()) {
          timedOut = true;
          stepSummaries.push({
            step,
            ok: false,
            detail: "dream maxRuntimeMinutes deadline reached",
            skipped: true,
          });
          break;
        }

        const runner = options.steps?.[step];
        if (!runner) {
          stepSummaries.push({
            step,
            ok: true,
            detail: "no runner bound (record-only)",
            skipped: true,
          });
          continue;
        }

        try {
          const result = await runner({
            dreamRunId: run.id,
            sessionIds,
            steeringPolicyId: options.steeringPolicyId ?? steering.profile,
            steering,
            dryRun: !liveMutateCompose,
          });
          stepSummaries.push({ step, ok: true, detail: result.detail });
          if (result.candidates?.length) {
            collectedCandidates.push(...result.candidates);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          pluginLogger.warn(`memory-hybrid: dream ${run.id} step ${step} failed: ${message}`);
          stepSummaries.push({ step, ok: false, detail: message });
        }
      }

      // If compose mutated the live store (legacy escape), rebase OCC snapshot before promote.
      if (liveMutateCompose) {
        store.setInputStoreRevision(run.id, factsDb.computeStoreRevision());
      }

      // Curriculum summary is metrics-only — never a promoteable candidate (#2170/#2171).
      // Real learning must come from compose stage proposed ops.
      if (collectedCandidates.length === 0) {
        const summary = curriculumCandidate({
          dreamRunId: run.id,
          sessionIds,
          stepSummaries,
          compose,
        });
        store.setDreamRunMetrics(run.id, {
          metricsSummaryJson: JSON.stringify({
            steering: {
              profile: steering.profile,
              promote: steering.promote,
              ignore: steering.ignore,
              notes: steering.notes ?? null,
            },
            curriculumSummary: {
              text: summary.payload.text,
              compose,
              stepSummaries,
              note: "no_stage_candidates — shadow/dry-run stages emitted zero proposed ops",
            },
            recordedAt: Math.floor(Date.now() / 1000),
          }),
        });
        pluginLogger.info(
          `memory-hybrid: dream ${run.id} produced zero stage candidates; curriculum summary recorded in metrics only`,
        );
      }

      const candidates =
        collectedCandidates.length > 0 ? store.appendCandidateEntries(run.id, collectedCandidates) : [];

      const shouldPromote =
        options.promote === true ||
        options.forcePromote === true ||
        (options.promote !== false && (cfg.promoteAfterRun || cfg.autoPromote.enabled));

      let promoteResult: PromoteResult | undefined;
      if (shouldPromote) {
        promoteResult = promoteDreamRun(factsDb, store, run.id, {
          force: options.forcePromote === true,
          cfg,
        });
      }

      const endedAt = Math.floor(Date.now() / 1000);
      const summary = buildRunMetricsSummary(factsDb, {
        sessionIds,
        startedAt: run.startedAt ?? run.createdAt,
        endedAt,
      });
      try {
        const prior = store.getDreamRun(run.id);
        let priorJson: Record<string, unknown> = {};
        if (prior?.metricsSummaryJson) {
          try {
            priorJson = JSON.parse(prior.metricsSummaryJson) as Record<string, unknown>;
          } catch {
            priorJson = {};
          }
        }
        store.setDreamRunMetrics(run.id, {
          metricsSummaryJson: JSON.stringify({
            ...priorJson,
            ...summary,
            steering: {
              profile: steering.profile,
              promote: steering.promote,
              ignore: steering.ignore,
              notes: steering.notes ?? null,
            },
            attachment: {
              includedCount: sessionIds.length,
              excludedCount: options.excludedSessions?.length ?? 0,
              excluded: options.excludedSessions ?? [],
            },
            candidateCount: candidates.length,
          }),
        });
      } catch {
        // Best-effort ROI row (#2179).
      }

      const updated = store.getDreamRun(run.id) ?? run;
      return {
        dreamRunId: run.id,
        run: updated,
        candidates,
        stepSummaries,
        promoteResult,
        timedOut,
        costFeature: CostFeature.dream,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.updateDreamRunStatus(run.id, "failed", { failureReason: message });
      throw err;
    } finally {
      clearMaintenanceRunDeadline();
    }
  });
}

/** Map dreaming.compose / skipNightlyOverlap onto nightly maintenance step names. */
export function nightlyStepsOwnedByDream(cfg: DreamingConfig | null | undefined): ReadonlySet<string> {
  if (!cfg?.enabled || !cfg.skipNightlyOverlap) return new Set();
  const owned = new Set<string>();
  for (const step of resolveCompose(cfg)) {
    switch (step) {
      case "distill":
        owned.add("distill");
        break;
      case "self-correction":
        owned.add("self-correction-run");
        break;
      case "contradictions":
        owned.add("contradiction-candidates");
        owned.add("resolve-contradictions");
        break;
      case "reflect":
        owned.add("reflect");
        owned.add("reflect-rules");
        owned.add("reflect-meta");
        owned.add("reflect-identity");
        break;
      case "consolidate":
        owned.add("consolidate");
        break;
      case "dream-cycle-core":
        owned.add("dream-cycle-core");
        break;
      default:
        break;
    }
  }
  return owned;
}
