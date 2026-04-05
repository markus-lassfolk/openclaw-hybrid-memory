/**
 * Heartbeat detection, multi-goal weighted stewardship blocks, round-robin cursor.
 * @see docs/GOAL-STEWARDSHIP-DESIGN.md §10.1
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GoalStewardshipAttentionWeights, GoalStewardshipConfig } from "../config/types/index.js";
import { listActiveGoals } from "./goal-registry.js";
import type { Goal } from "./goal-stewardship-types.js";

const RR_FILE = "_stewardship_rr.json";

/** Built-in pattern sources when `heartbeatPatterns` is empty (case-insensitive). */
export const DEFAULT_HEARTBEAT_PATTERN_SOURCES = ["heartbeat", "scheduled ping", "cron heartbeat"];

export function compileHeartbeatMatchers(patterns: string[]): RegExp[] {
  const src = patterns.length > 0 ? patterns : DEFAULT_HEARTBEAT_PATTERN_SOURCES;
  const out: RegExp[] = [];
  for (const s of src) {
    try {
      if (s.startsWith("/") && s.lastIndexOf("/") > 0) {
        const last = s.lastIndexOf("/");
        const body = s.slice(1, last);
        let flags = s.slice(last + 1) || "i";
        flags = flags.replace(/[gy]/g, "");
        if (!flags.includes("i")) flags += "i";
        out.push(new RegExp(body, flags));
      } else {
        out.push(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
      }
    } catch {
      /* skip bad pattern */
    }
  }
  if (out.length === 0) {
    out.push(/heartbeat/i);
  }
  return out;
}

let cachedPatternKey: string | null = null;
let cachedMatchers: RegExp[] = [];

export function getCachedMatchers(patterns: string[]): RegExp[] {
  const key = patterns.join("\0");
  if (key !== cachedPatternKey) {
    cachedPatternKey = key;
    cachedMatchers = compileHeartbeatMatchers(patterns);
  }
  return cachedMatchers;
}

export function matchesHeartbeat(userText: string, cfg: GoalStewardshipConfig): boolean {
  const t = userText.trim();
  if (!t) return false;
  const matchers = getCachedMatchers(cfg.heartbeatPatterns);
  return matchers.some((re) => re.test(t));
}

function priorityWeight(p: Goal["priority"], w: GoalStewardshipAttentionWeights): number {
  switch (p) {
    case "critical":
      return w.critical;
    case "high":
      return w.high;
    case "low":
      return w.low;
    default:
      return w.normal;
  }
}

export interface StewardshipRoundRobinState {
  offset: number;
}

async function readRoundRobin(goalsDir: string): Promise<StewardshipRoundRobinState> {
  try {
    const raw = await readFile(join(goalsDir, RR_FILE), "utf-8");
    const j = JSON.parse(raw) as { offset?: number };
    return { offset: typeof j.offset === "number" && j.offset >= 0 ? Math.floor(j.offset) : 0 };
  } catch {
    return { offset: 0 };
  }
}

async function writeRoundRobin(goalsDir: string, state: StewardshipRoundRobinState): Promise<void> {
  await writeFile(
    join(goalsDir, RR_FILE),
    JSON.stringify({ offset: state.offset, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
}

function candidateGoals(goals: Goal[], now: number): Goal[] {
  return goals.filter((goal) => {
    if (goal.status === "blocked") return false;
    const last = goal.lastAssessedAt ?? goal.createdAt;
    const lastMs = Date.parse(last);
    const elapsed = now - (Number.isNaN(lastMs) ? 0 : lastMs);
    const cooldownMs = goal.cooldownMinutes * 60 * 1000;
    return elapsed >= cooldownMs;
  });
}

function sortGoalsForRoundRobin(goals: Goal[], weights: GoalStewardshipAttentionWeights): Goal[] {
  return [...goals].sort((a, b) => {
    const wd = priorityWeight(b.priority, weights) - priorityWeight(a.priority, weights);
    if (wd !== 0) return wd;
    const aT = Date.parse(a.lastAssessedAt ?? a.createdAt);
    const bT = Date.parse(b.lastAssessedAt ?? b.createdAt);
    return aT - bT;
  });
}

/** Heuristic: substantive stewardship suggests heavy-tier follow-up. */
export function heuristicNeedsHeavyAttention(goals: Goal[]): boolean {
  for (const g of goals) {
    if (g.status === "verifying" || g.status === "stalled") return true;
    if (g.currentBlockers.length > 0) return true;
    if ((g.consecutiveFailures ?? 0) > 0) return true;
  }
  return false;
}

export function buildStewardshipBlockFull(goal: Goal, allActive: number): string {
  const criteria = goal.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
  const blockers = goal.currentBlockers.length > 0 ? goal.currentBlockers.map((b) => `  - ${b}`).join("\n") : "  none";
  const linked =
    goal.linkedTasks.length > 0 ? goal.linkedTasks.map((t) => `  - ${t.label}: ${t.status}`).join("\n") : "  (none)";
  let directive = "Assess progress toward acceptance criteria; dispatch work or call goal_assess.";
  if (goal.status === "verifying") {
    directive = "Verify all criteria are met; call goal_complete if done.";
  } else if (goal.currentBlockers.length > 0) {
    directive = "Address blockers; update via goal_assess.";
  }
  return `<goal-stewardship>
## Active Goal: ${goal.label} (priority: ${goal.priority}, id: ${goal.id})

**Description:** ${goal.description}

**Acceptance Criteria:**
${criteria}

**State:** ${goal.status} | assessments ${goal.assessmentCount}/${goal.maxAssessments} | dispatches ${goal.dispatchCount}/${goal.maxDispatches}
**Last outcome:** ${goal.lastOutcome ?? "none"}
**Blockers:**
${blockers}

**Linked tasks:**
${linked}

**Other active goals:** ${Math.max(0, allActive - 1)}

**Directive:** ${directive}

Use goal_assess after reviewing. Use goal_complete only when criteria are verifiably satisfied.
</goal-stewardship>`;
}

export function buildStewardshipBlockCompact(goal: Goal, maxChars: number, allActive: number): string {
  const full = buildStewardshipBlockFull(goal, allActive);
  if (full.length <= maxChars) return full;
  return `${full.slice(0, Math.max(200, maxChars - 80))}\n…(truncated)\n</goal-stewardship>`;
}

export interface BuildMultiGoalStewardshipResult {
  prepend: string;
  goalsIncluded: Goal[];
  suggestHeavy: boolean;
}

export async function buildMultiGoalStewardshipPrepend(
  goalsDir: string,
  cfg: GoalStewardshipConfig,
  allGoals: Goal[],
  opts: { suggestHeavyDirective: boolean; triageHeavy: boolean },
): Promise<BuildMultiGoalStewardshipResult | null> {
  const now = Date.now();
  const candidates = sortGoalsForRoundRobin(candidateGoals(allGoals, now), cfg.attentionWeights);
  if (candidates.length === 0) return null;

  const rr = await readRoundRobin(goalsDir);
  const rot = rr.offset % candidates.length;
  const rotated = [...candidates.slice(rot), ...candidates.slice(0, rot)];
  const nextOff = (rot + 1) % Math.max(1, candidates.length);
  await writeRoundRobin(goalsDir, { offset: nextOff });

  const maxGoals = Math.min(cfg.multiGoalMaxGoals, rotated.length);
  const selected = rotated.slice(0, maxGoals);

  const weights = selected.map((g) => priorityWeight(g.priority, cfg.attentionWeights));
  const sumW = weights.reduce((a, b) => a + b, 0) || 1;
  const cap = cfg.multiGoalMaxChars;
  const budgets = weights.map((w) => Math.max(400, Math.floor((w / sumW) * cap)));

  const blocks: string[] = [];
  let suggestHeavy = opts.triageHeavy;
  const totalActive = allGoals.length;
  for (let i = 0; i < selected.length; i++) {
    const g = selected[i];
    if (!g) continue;
    const budget = budgets[i] ?? 2000;
    const block = buildStewardshipBlockCompact(g, budget, totalActive);
    blocks.push(block);
    if (heuristicNeedsHeavyAttention([g])) suggestHeavy = true;
  }

  let header = "<goal-stewardship-bundle>\n";
  header += `<!-- goals: ${selected.length} | cap: ${cap} chars | rr: ${rr.offset}->${nextOff} -->\n`;
  if (opts.suggestHeavyDirective && suggestHeavy) {
    header += "<!-- triage: prefer heavy-tier model or deliberate tool use for substantive dispatch this turn -->\n";
  }
  const prepend = `${header}${blocks.join("\n\n")}\n</goal-stewardship-bundle>\n\n`;
  return { prepend, goalsIncluded: selected, suggestHeavy };
}
