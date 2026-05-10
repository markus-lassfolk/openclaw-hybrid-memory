/**
 * Task hygiene — stronger nudges for ACTIVE-TASKS.md rows (separate from Goals).
 * @see docs/TASK-HYGIENE.md
 */

import { basename } from "node:path";
import type { ActiveTaskEntry } from "./active-task.js";
import { isSubagentSession } from "./active-task.js";
import type { ActiveTaskLongRunningRegistrationMode } from "../config/types/index.js";

export type LongRunningWorkflowKind = "pr_queue" | "pr_until_merged" | "ci_monitor" | "issue_sweep" | "deployment";
export type LongRunningRegistrationMode = ActiveTaskLongRunningRegistrationMode;

export type LongRunningWorkflowProposal = {
  kind: LongRunningWorkflowKind;
  label: string;
  description: string;
  next: string;
  repoContext?: string;
};

const REPO_REF_RE = /\b([a-z0-9][a-z0-9_.-]{1,98})\/([a-z0-9][a-z0-9_.-]{1,98})\b/gi;
const GITHUB_URL_RE =
  /(?:https?:\/\/)?(?:www\.)?github\.com\/([a-z0-9][a-z0-9_.-]{1,98})\/([a-z0-9][a-z0-9_.-]{1,98})(?:[/?#\s,;.)]|$)/gi;
const PR_NUM_RE = /(?:\bpr\b|\bpull request\b)?\s*#(\d+)\b/i;
const DEPLOY_TARGET_RE = /\b(prod|production|staging|stage|qa|dev|preview)\b/i;
const DEPLOY_ACTION_RE =
  /\b(?:deploy|rollout)\b|\b(run|start|trigger|execute|perform|monitor|watch|track)\b[\s\S]{0,30}\b(deploy|deployment|rollout)\b/i;
const RELEASE_TO_ENV_RE =
  /\brelease\b[\s\S]{0,25}\b(to|into)\b[\s\S]{0,10}\b(prod|production|staging|stage|qa|dev|preview)\b|\b(run|start|trigger|execute|perform|monitor|watch|track)\b[\s\S]{0,30}\brelease\b[\s\S]{0,25}\b(to|into)\b[\s\S]{0,10}\b(prod|production|staging|stage|qa|dev|preview)\b/i;
const ISSUE_SWEEP_RE =
  /\bfix\b[\s\S]{0,10}\ball\b[\s\S]{0,10}\b(?:open\s+|the\s+)?issues?\b(?!\s+(?:with|on|for|from|at|about)|\s+in\s+(?!(?:this\s+|the\s+)?(?:repo|repository|github|backlog)))/i;
const GENERIC_WORKSPACE_NAMES = new Set(["workspace", "workspaces", "tmp", "home", "openclaw", "task"]);
const SLASH_NOISE_TOKENS = new Set(["and", "or", "on", "off", "to", "for", "in", "by", "up", "down", "yes", "no"]);

function slugifyToken(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "task";
}

function normalizeRepoToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.git$/i, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
}

function toRepoContext(owner: string, repo: string): string | undefined {
  const o = normalizeRepoToken(owner);
  const r = normalizeRepoToken(repo);
  if (!o || !r) return undefined;
  if (o.includes(".")) return undefined;
  if (SLASH_NOISE_TOKENS.has(o) || SLASH_NOISE_TOKENS.has(r)) return undefined;
  return `${o}-${r}`;
}

function normalizeRepoContext(userText: string, workspaceRoot?: string): string | undefined {
  for (const match of userText.matchAll(GITHUB_URL_RE)) {
    const owner = match[1] ?? "";
    const repo = match[2] ?? "";
    const ctx = toRepoContext(owner, repo);
    if (ctx) return ctx;
  }
  for (const match of userText.matchAll(REPO_REF_RE)) {
    const owner = match[1] ?? "";
    const repo = match[2] ?? "";
    const ctx = toRepoContext(owner, repo);
    if (ctx) return ctx;
  }
  if (!workspaceRoot?.trim()) return undefined;
  const base = basename(workspaceRoot.trim());
  const normalized = slugifyToken(base);
  if (GENERIC_WORKSPACE_NAMES.has(normalized)) return undefined;
  return normalized;
}

function withRepoPrefix(base: string, repo?: string): string {
  return repo?.trim() ? `wf-${repo}-${base}` : `wf-${base}`;
}

function buildWorkflowProposal(
  kind: LongRunningWorkflowKind,
  userText: string,
  workspaceRoot?: string,
): LongRunningWorkflowProposal {
  const repoContext = normalizeRepoContext(userText, workspaceRoot);
  const prNumber = PR_NUM_RE.exec(userText)?.[1];
  const deployTarget = DEPLOY_TARGET_RE.exec(userText)?.[1]?.toLowerCase();

  if (kind === "pr_queue") {
    return {
      kind,
      label: withRepoPrefix("pr-queue", repoContext),
      description: `Process PR queue${repoContext ? ` (${repoContext})` : ""}`,
      next: "Review pending PRs and move each one to merge-ready or blocked with explicit blockers.",
      repoContext,
    };
  }

  if (kind === "pr_until_merged") {
    const suffix = prNumber ? `pr-${prNumber}-until-merged` : "pr-until-merged";
    return {
      kind,
      label: withRepoPrefix(suffix, repoContext),
      description: prNumber
        ? `Drive PR #${prNumber} to merged state${repoContext ? ` (${repoContext})` : ""}`
        : `Drive PR workflow to merged state${repoContext ? ` (${repoContext})` : ""}`,
      next: "Track CI/review feedback, apply fixes, and continue until merge criteria are satisfied.",
      repoContext,
    };
  }

  if (kind === "ci_monitor") {
    return {
      kind,
      label: withRepoPrefix("ci-monitor", repoContext),
      description: `Monitor CI workflow${repoContext ? ` (${repoContext})` : ""}`,
      next: "Watch CI checks, triage failures, and report pass/fail with concrete next action.",
      repoContext,
    };
  }

  if (kind === "issue_sweep") {
    return {
      kind,
      label: withRepoPrefix("issue-sweep", repoContext),
      description: `Fix all open issues${repoContext ? ` (${repoContext})` : ""}`,
      next: "Work through issues in priority order and track unresolved blockers explicitly.",
      repoContext,
    };
  }

  return {
    kind,
    label: withRepoPrefix(`deploy-${slugifyToken(deployTarget ?? "workflow")}`, repoContext),
    description: `Deployment workflow${deployTarget ? ` (${deployTarget})` : ""}${repoContext ? ` for ${repoContext}` : ""}`,
    next: "Run deployment steps, monitor rollout health, and confirm outcome before closing the task.",
    repoContext,
  };
}

export function detectLongRunningWorkflowProposal(
  userText: string,
  workspaceRoot?: string,
): LongRunningWorkflowProposal | null {
  const text = userText.trim();
  if (!text) return null;

  if (/\bpr queue\b/i.test(text)) {
    return buildWorkflowProposal("pr_queue", text, workspaceRoot);
  }
  if (/\bcontinue\b[\s\S]{0,40}\buntil\b[\s\S]{0,30}\bmerged\b/i.test(text)) {
    return buildWorkflowProposal("pr_until_merged", text, workspaceRoot);
  }
  if (
    /\b(monitor|watch|track)\b[\s\S]{0,20}\bci\b/i.test(text) ||
    /\b(wait|waiting)\b[\s\S]{0,25}\b(ci|checks?)\b/i.test(text)
  ) {
    return buildWorkflowProposal("ci_monitor", text, workspaceRoot);
  }
  if (ISSUE_SWEEP_RE.test(text)) {
    return buildWorkflowProposal("issue_sweep", text, workspaceRoot);
  }
  if (DEPLOY_ACTION_RE.test(text) || RELEASE_TO_ENV_RE.test(text)) {
    return buildWorkflowProposal("deployment", text, workspaceRoot);
  }
  return null;
}

export function buildLongRunningTaskDraft(
  proposal: LongRunningWorkflowProposal,
  nowIso = new Date().toISOString(),
): ActiveTaskEntry {
  return {
    label: proposal.label,
    description: proposal.description,
    status: "In progress",
    next: proposal.next,
    started: nowIso,
    updated: nowIso,
  };
}

function isMainOrPrivateSessionKey(sessionKey?: string | null): boolean {
  if (!sessionKey) return false;
  const trimmed = sessionKey.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.startsWith("agent:main:") || trimmed.startsWith("agent:private:")) return true;
  return trimmed === "main" || trimmed === "private";
}

export function shouldAutoRegisterLongRunningTask(
  mode: LongRunningRegistrationMode,
  sessionKey?: string | null,
): boolean {
  return (
    mode === "auto_main_private" && isMainOrPrivateSessionKey(sessionKey) && !isSubagentSession(sessionKey ?? undefined)
  );
}

export function buildLongRunningTaskRegistrationBlock(
  proposal: LongRunningWorkflowProposal,
  draft: ActiveTaskEntry,
  opts: {
    mode: LongRunningRegistrationMode;
    autoCreated: boolean;
    alreadyActive: boolean;
    sessionKey?: string | null;
  },
): string {
  const lines = [
    "<active-task-registration>",
    `**Long-running workflow detected:** ${proposal.kind.replace(/_/g, " ")}`,
    `- Stable task label: \`${draft.label}\`${proposal.repoContext ? ` (repo context: \`${proposal.repoContext}\`)` : ""}`,
  ];

  if (opts.autoCreated) {
    lines.push("- Auto-registered this task in the active-task ledger (auto_main_private policy).");
  } else if (opts.alreadyActive) {
    lines.push("- Matching active task already exists; continuing with existing tracking row.");
  } else if (opts.mode === "confirm") {
    lines.push("- Guard: register/confirm this task before proceeding with external workflow mutations.");
  } else if (opts.mode === "auto_main_private" && !shouldAutoRegisterLongRunningTask(opts.mode, opts.sessionKey)) {
    lines.push("- Auto-registration policy only applies to main/private sessions; register this task manually.");
  } else {
    lines.push("- Suggested registration payload (use `active-tasks add` or project facts equivalent):");
  }

  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        label: draft.label,
        description: draft.description,
        status: draft.status,
        next: draft.next,
      },
      null,
      2,
    ),
  );
  lines.push("```");
  lines.push(
    "- For outcome-oriented multi-session execution, follow with `active_task_propose_goal` + `goal_register`.",
  );
  lines.push("</active-task-registration>");
  return lines.join("\n");
}

export function buildHeartbeatTaskHygieneBlock(
  tasks: ActiveTaskEntry[],
  opts: {
    maxChars: number;
    suggestGoalAfterTaskAgeDays: number;
  },
): string {
  const stale = tasks.filter((t) => t.stale);
  const lines: string[] = [
    "<task-hygiene>",
    "**Heartbeat — active task review**",
    "Reconcile ACTIVE-TASKS.md: complete finished work, update **Next**, or verify subagents before replying HEARTBEAT_OK.",
  ];

  if (stale.length > 0) {
    lines.push(
      `- **Stale tasks (${stale.length}):** ${stale.map((t) => `[${t.label}]`).join(", ")} — update or complete.`,
    );
  } else {
    lines.push("- No tasks flagged stale by the current threshold.");
  }

  if (opts.suggestGoalAfterTaskAgeDays > 0) {
    const cutoff = Date.now() - opts.suggestGoalAfterTaskAgeDays * 86_400_000;
    const longRunning = tasks.filter((t) => {
      const u = new Date(t.updated).getTime();
      return !Number.isNaN(u) && u < cutoff;
    });
    if (longRunning.length > 0) {
      lines.push(
        `- **Long-running (>${opts.suggestGoalAfterTaskAgeDays}d since last update):** ${longRunning.map((t) => `[${t.label}]`).join(", ")}`,
      );
      lines.push(
        "- If this work should survive many sessions, use **`active_task_propose_goal`** then **`goal_register`** (with acceptance criteria).",
      );
    }
  }

  lines.push("</task-hygiene>");
  let out = lines.join("\n");
  if (out.length > opts.maxChars) {
    out = `${out.slice(0, opts.maxChars - 20)}\n…(truncated)\n</task-hygiene>`;
  }
  return out;
}

/** Nudge on heartbeat when goals are blocked/stalled but ACTIVE-TASKS may look fine (issue #1096). */
export function buildGoalEscalationHeartbeatBlock(
  goals: Array<{ label: string; status: string }>,
  opts: { maxChars: number },
): string {
  const bad = goals.filter((g) => g.status === "blocked" || g.status === "stalled");
  if (bad.length === 0) return "";
  const lines: string[] = [
    "<goal-escalation>",
    "**Heartbeat — blocked or stalled goals**",
    "Do not reply HEARTBEAT_OK as if everything is fine until these are triaged or unblocked.",
    ...bad.map((g) => `- **[${g.label}]** (${g.status})`),
    "</goal-escalation>",
  ];
  const closingTag = "</goal-escalation>";
  const body = lines.join("\n");
  if (body.length <= opts.maxChars) {
    return body;
  }
  const openingTag = "<goal-escalation>";
  const truncatedSuffix = `\n…(truncated)\n${closingTag}`;
  const minChars = openingTag.length + truncatedSuffix.length;
  if (opts.maxChars < minChars) {
    return `${openingTag}${truncatedSuffix}`;
  }
  const availableBodyChars = opts.maxChars - truncatedSuffix.length;
  return `${body.slice(0, availableBodyChars)}${truncatedSuffix}`;
}

export function buildProposeGoalDraftFromTask(task: ActiveTaskEntry): {
  suggestedLabel: string;
  suggestedDescription: string;
  suggestedCriteria: string[];
  notes: string;
} {
  const criteria: string[] = [];
  if (task.next?.trim()) criteria.push(`Complete next step: ${task.next.trim()}`);
  criteria.push(`Task was in status "${task.status}" (from ACTIVE-TASKS.md).`);
  criteria.push("Verify outcome matches user expectations before calling goal_complete.");
  return {
    suggestedLabel: task.label,
    suggestedDescription: task.description || `Follow through on active task [${task.label}]`,
    suggestedCriteria: criteria,
    notes:
      "This is a draft from the task row — refine acceptance_criteria with the user before goal_register when policy requires confirmation.",
  };
}
