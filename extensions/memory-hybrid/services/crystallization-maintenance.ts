/**
 * CLI / cron entry points for crystallization maintenance (proposal cycle + rescan).
 */

import { CrystallizationStore } from "../backends/crystallization-store.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { CrystallizationProposer } from "./crystallization-proposer.js";
import { defaultWorkflowDbPath } from "./maintenance-coverage.js";
import { pendingStorePaths } from "./pending-review-digest.js";

export type CrystallizationCycleResult = {
  proposed: number;
  skipped: number;
  reasons: string[];
  skippedReason?: "disabled" | "stores-unavailable";
};

export function runCrystallizationProposalCycle(cfg: HybridMemoryConfig): CrystallizationCycleResult {
  if (!cfg.crystallization?.enabled) {
    return { proposed: 0, skipped: 0, reasons: ["Crystallization is disabled"], skippedReason: "disabled" };
  }

  const paths = pendingStorePaths(cfg.sqlitePath);
  let wfStore: WorkflowStore | null = null;
  let cStore: CrystallizationStore | null = null;
  try {
    wfStore = new WorkflowStore(defaultWorkflowDbPath());
    cStore = new CrystallizationStore(paths.crystallization);
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg.crystallization);
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
