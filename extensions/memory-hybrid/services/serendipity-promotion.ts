/**
 * Serendipity promotion (Issue #2119, phase 2).
 *
 * Converts a finding into durable work under existing, guardrailed machinery:
 *  - goal   → goal-registry (goal stewardship then drives it to completion)
 *  - task   → active-task ledger
 *  - skill  → Skill Workshop proposal
 *
 * Each promotion links back to the finding and transitions it to `proposed`
 * (out of the actionable backlog). Nothing here edits code or bypasses approval;
 * it hands work to systems that already enforce their own guardrails.
 */

import type { EventLog } from "../backends/event-log.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { SerendipityStore } from "../backends/serendipity-store.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { HybridMemoryConfig } from "../config.js";
import type { ScopeFilter } from "../types/memory.js";
import type { SerendipityFinding } from "../types/serendipity-types.js";
import { runActiveTaskCheckpoint } from "./active-task-checkpoint.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { createGoalWithCapCheck } from "./goal-registry.js";
import { goalStewardshipDefaultsFromConfig } from "./goal-stewardship.js";
import { isSkillWorkshopPluginActive, writeSkillWorkshopProposal } from "./skill-workshop-bridge.js";

export type PromotionTarget = "goal" | "task" | "skill";

export interface SerendipityPromotionDeps {
  store: SerendipityStore;
  cfg: HybridMemoryConfig;
  /** Resolved goals directory (required for target=goal). */
  goalsDir?: string;
  eventLog?: EventLog | null;
  factsDb?: FactsDB | null;
  vectorDb?: VectorDB | null;
  embeddings?: EmbeddingProvider | null;
  workspaceRoot?: string;
  scopeFilter?: ScopeFilter | null;
  /** Plugin API surface used only to detect whether the Skill Workshop is active. */
  api?: { getTool?: (name: string) => unknown };
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}

export interface PromotionResult {
  ok: boolean;
  target: PromotionTarget;
  /** goal id / task entity / proposal id, when created. */
  refId?: string;
  message: string;
}

function goalPriorityForRisk(finding: SerendipityFinding): "critical" | "high" | "normal" | "low" {
  if (finding.riskLevel === "high") return "high";
  if (finding.riskLevel === "medium") return "normal";
  return "low";
}

function findingAcceptanceCriteria(finding: SerendipityFinding): string[] {
  const criteria = [`Resolve serendipity finding "${finding.title}" (${finding.findingType})`];
  if (finding.suggestedAction === "file_issue") criteria.push("File an issue with evidence and link it back.");
  else if (finding.suggestedAction === "fix_now") criteria.push("Apply the fix and verify it.");
  else criteria.push("Decide and record the outcome (fix / file / dismiss).");
  return criteria;
}

function taskEntityFor(finding: SerendipityFinding): string {
  return `serendipity-${finding.id.slice(0, 8)}`;
}

export async function promoteFinding(
  finding: SerendipityFinding,
  target: PromotionTarget,
  deps: SerendipityPromotionDeps,
): Promise<PromotionResult> {
  switch (target) {
    case "goal":
      return promoteToGoal(finding, deps);
    case "task":
      return promoteToTask(finding, deps);
    case "skill":
      return promoteToSkillProposal(finding, deps);
  }
}

export async function promoteToGoal(
  finding: SerendipityFinding,
  deps: SerendipityPromotionDeps,
): Promise<PromotionResult> {
  const gs = deps.cfg.goalStewardship;
  if (!gs.enabled || !deps.goalsDir) {
    return { ok: false, target: "goal", message: "Goal stewardship is disabled; cannot promote to a goal." };
  }
  const defaults = goalStewardshipDefaultsFromConfig(gs);
  // Goal labels must be slug-like ([A-Za-z0-9_-]); the readable title lives in the description.
  const label = `serendipity-${finding.id.slice(0, 8)}`;
  const body = finding.description || finding.title;
  const description =
    finding.evidence.length > 0
      ? `${finding.title}\n\n${body}\n\nEvidence:\n- ${finding.evidence.join("\n- ")}`
      : `${finding.title}\n\n${body}`;
  const goal = await createGoalWithCapCheck(
    deps.goalsDir,
    {
      label,
      description,
      acceptanceCriteria: findingAcceptanceCriteria(finding),
      priority: goalPriorityForRisk(finding),
    },
    defaults,
    gs.globalLimits.maxActiveGoals,
    deps.eventLog,
  );
  if (!goal) {
    return { ok: false, target: "goal", message: `Max active goals (${gs.globalLimits.maxActiveGoals}) reached.` };
  }
  deps.store.transition(finding.id, "proposed", {
    actionTaken: `Promoted to goal ${goal.id}`,
    metadata: { ...finding.metadata, goalId: goal.id },
  });
  return { ok: true, target: "goal", refId: goal.id, message: `Created goal ${goal.id} from finding.` };
}

export async function promoteToTask(
  finding: SerendipityFinding,
  deps: SerendipityPromotionDeps,
): Promise<PromotionResult> {
  if (!deps.cfg.activeTask.enabled || !deps.factsDb || !deps.vectorDb || !deps.embeddings) {
    return { ok: false, target: "task", message: "Active task ledger is unavailable; cannot promote to a task." };
  }
  const entity = taskEntityFor(finding);
  const cp = await runActiveTaskCheckpoint(
    {
      factsDb: deps.factsDb,
      vectorDb: deps.vectorDb,
      embeddings: deps.embeddings,
      cfg: deps.cfg,
      logger: deps.logger,
      workspaceRoot: deps.workspaceRoot,
      scopeFilter: deps.scopeFilter ?? null,
    },
    {
      entity,
      status: "in_progress",
      title: finding.title.slice(0, 120),
      next: `Address serendipity finding (${finding.findingType})`,
      state: { serendipityFindingId: finding.id },
    },
  );
  if (!cp.ok) {
    return { ok: false, target: "task", message: `Task checkpoint failed: ${cp.message}` };
  }
  deps.store.transition(finding.id, "proposed", {
    actionTaken: `Promoted to active task ${entity}`,
    metadata: { ...finding.metadata, taskEntity: entity },
  });
  return { ok: true, target: "task", refId: entity, message: `Created active task ${entity} from finding.` };
}

export async function promoteToSkillProposal(
  finding: SerendipityFinding,
  deps: SerendipityPromotionDeps,
): Promise<PromotionResult> {
  const proposalId = `serendipity-${finding.id.slice(0, 8)}`;
  const skillContent = [
    `# ${finding.title}`,
    "",
    `Proposed from a serendipity finding (${finding.findingType}, risk ${finding.riskLevel}).`,
    "",
    "## Problem",
    finding.description || finding.title,
    "",
    "## Evidence",
    finding.evidence.length > 0 ? finding.evidence.map((e) => `- ${e}`).join("\n") : "- (none recorded)",
    "",
    "## Suggested action",
    `- ${finding.suggestedAction}`,
  ].join("\n");

  const res = writeSkillWorkshopProposal({
    name: finding.title.slice(0, 80),
    description: (finding.description || finding.title).slice(0, 160),
    skillContent,
    proposalId,
  });
  if (!res.ok) {
    return { ok: false, target: "skill", message: `Skill Workshop proposal failed: ${res.error}` };
  }
  deps.store.linkRecord(finding.id, "skill", proposalId);
  deps.store.transition(finding.id, "proposed", {
    actionTaken: `Proposed Skill Workshop skill ${proposalId}`,
    metadata: { ...finding.metadata, skillProposalId: proposalId, skillProposalPath: res.path },
  });
  const active = isSkillWorkshopPluginActive(deps.api)
    ? ""
    : " (Skill Workshop plugin not detected — proposal saved for later review)";
  return {
    ok: true,
    target: "skill",
    refId: proposalId,
    message: `Wrote Skill Workshop proposal ${proposalId}.${active}`,
  };
}
