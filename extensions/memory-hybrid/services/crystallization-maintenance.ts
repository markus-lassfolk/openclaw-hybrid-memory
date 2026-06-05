/**
 * CLI / cron entry points for crystallization maintenance (proposal cycle + rescan).
 */

import { CrystallizationStore } from "../backends/crystallization-store.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import type { HybridMemoryConfig } from "../config.js";
import type { ChangeFeed } from "./change-feed.js";
import { CrystallizationProposer } from "./crystallization-proposer.js";
import { defaultWorkflowDbPath } from "./maintenance-coverage.js";
import { pendingStorePaths } from "./pending-review-digest.js";
import { detectCrystallizationCandidates } from "./pattern-detector.js";
import { patternHasUserFacingGoal } from "./workflow-goal-classifier.js";

export type CrystallizationCycleResult = {
  proposed: number;
  skipped: number;
  reasons: string[];
  skippedReason?: "disabled" | "stores-unavailable";
};

export type CrystallizationPreviewCandidate = {
  patternId: string;
  score: number;
  toolSequence: string[];
  totalCount: number;
  successRate: number;
  exampleGoals: string[];
};

export type CrystallizationPreviewResult = {
  candidates: CrystallizationPreviewCandidate[];
  reasons: string[];
  patternCounts: { raw: number; userFacing: number };
  skippedReason?: "stores-unavailable";
};

/** Preview crystallization candidates without writing proposals (ignores crystallization.enabled). */
export function previewCrystallizationCycle(
  cfg: HybridMemoryConfig,
  opts?: { limit?: number; workflowDbPath?: string },
): CrystallizationPreviewResult {
  const crystalCfg = cfg.crystallization;
  if (!crystalCfg) {
    return { candidates: [], reasons: ["Crystallization config is missing"], patternCounts: { raw: 0, userFacing: 0 } };
  }

  const limit = opts?.limit ?? 12;
  let wfStore: WorkflowStore | null = null;
  let cStore: CrystallizationStore | null = null;
  try {
    wfStore = new WorkflowStore(opts?.workflowDbPath ?? defaultWorkflowDbPath());
    cStore = new CrystallizationStore(pendingStorePaths(cfg.sqlitePath).crystallization);
    const previewCfg = { ...crystalCfg, enabled: true };
    const rawPatterns = wfStore.getPatterns({
      minSuccessRate: 0,
      limit: 50,
      traceSampleLimit: 6000,
      excludeSystemGoals: false,
    });
    const userFacingPatterns = wfStore.getPatterns({
      minSuccessRate: crystalCfg.minSuccessRate,
      limit: 50,
      traceSampleLimit: 6000,
      excludeSystemGoals: crystalCfg.excludeSystemGoals,
      excludeGoalPatterns: crystalCfg.excludeGoalPatterns,
    });
    const candidates = detectCrystallizationCandidates(wfStore, cStore, previewCfg);
    const reasons: string[] = [];
    if (candidates.length === 0) {
      if (
        crystalCfg.excludeSystemGoals &&
        rawPatterns.length > 0 &&
        userFacingPatterns.length === 0
      ) {
        reasons.push(
          "Patterns exist but excludeSystemGoals removed all cron/system traces — waiting for user-facing workflow data",
        );
      } else if (rawPatterns.length === 0) {
        reasons.push("No workflow patterns found in workflow-traces.db");
      } else {
        reasons.push("No candidates meet minUsageCount/minSuccessRate thresholds");
      }
    }
    return {
      candidates: candidates.slice(0, limit).map((c) => ({
        patternId: c.patternId,
        score: c.score,
        toolSequence: c.pattern.toolSequence,
        totalCount: c.pattern.totalCount,
        successRate: c.pattern.successRate,
        exampleGoals: c.pattern.exampleGoals.slice(0, 3),
      })),
      reasons,
      patternCounts: {
        raw: rawPatterns.filter((p) => p.totalCount >= crystalCfg.minUsageCount).length,
        userFacing: userFacingPatterns.filter((p) =>
          patternHasUserFacingGoal(p.exampleGoals, {
            excludeSystemGoals: crystalCfg.excludeSystemGoals,
            excludeGoalPatterns: crystalCfg.excludeGoalPatterns,
          }),
        ).length,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      candidates: [],
      reasons: [`Preview failed: ${msg}`],
      patternCounts: { raw: 0, userFacing: 0 },
      skippedReason: "stores-unavailable",
    };
  } finally {
    wfStore?.close();
    cStore?.close();
  }
}

export function runCrystallizationProposalCycle(
  cfg: HybridMemoryConfig,
  opts?: { changeFeed?: ChangeFeed | null; sessionKey?: string },
): CrystallizationCycleResult {
  if (!cfg.crystallization?.enabled) {
    return { proposed: 0, skipped: 0, reasons: ["Crystallization is disabled"], skippedReason: "disabled" };
  }

  const paths = pendingStorePaths(cfg.sqlitePath);
  let wfStore: WorkflowStore | null = null;
  let cStore: CrystallizationStore | null = null;
  try {
    wfStore = new WorkflowStore(defaultWorkflowDbPath());
    cStore = new CrystallizationStore(paths.crystallization);
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg.crystallization, {
      changeFeed: opts?.changeFeed ?? null,
      cfg,
      sessionKey: opts?.sessionKey,
    });
    return proposer.runCycle();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      proposed: 0,
      skipped: 0,
      reasons: [`Crystallization cycle failed: ${msg}`],
      skippedReason: "stores-unavailable",
    };
  } finally {
    wfStore?.close();
    cStore?.close();
  }
}

export type CrystallizationRescanResult = ReturnType<CrystallizationProposer["rescanInstalledSkills"]>;

export function runCrystallizationSkillsRescan(cfg: HybridMemoryConfig): CrystallizationRescanResult {
  if (!cfg.crystallization?.enabled) {
    return {
      scanned: 0,
      quarantined: 0,
      skipped: 0,
      diskQuarantined: 0,
      errors: [],
      messages: ["Crystallization is disabled — rescan skipped"],
    };
  }

  const paths = pendingStorePaths(cfg.sqlitePath);
  let cStore: CrystallizationStore | null = null;
  try {
    cStore = new CrystallizationStore(paths.crystallization);
    const proposer = new CrystallizationProposer(null, cStore, cfg.crystallization);
    return proposer.rescanInstalledSkills();
  } finally {
    cStore?.close();
  }
}
