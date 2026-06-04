/**
 * Heartbeat detection, multi-goal weighted stewardship blocks, round-robin cursor.
 * @see docs/GOAL-STEWARDSHIP-DESIGN.md §10.1
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GoalStewardshipAttentionWeights, GoalStewardshipConfig } from "../config/types/index.js";
import type { Goal } from "./goal-stewardship-types.js";

const RR_FILE = "_stewardship_rr.json";
const RR_LOCK_DIR = ".stewardship-rr.lock";
const RR_LOCK_RETRY_MS = 25;
const RR_LOCK_MAX_RETRIES = 200;
const RR_LOCK_STALE_MS = 2 * 60 * 1000;

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
        if (body.length === 0) {
          continue;
        }
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

/** Clear the module-level regex cache (primarily for test isolation). */
export function clearMatcherCache(): void {
  cachedPatternKey = null;
  cachedMatchers = [];
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
  await mkdir(goalsDir, { recursive: true });
  await writeFile(
    join(goalsDir, RR_FILE),
    JSON.stringify({ offset: state.offset, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
}

async function withRoundRobinLock<T>(goalsDir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(goalsDir, { recursive: true });
  const lockPath = join(goalsDir, RR_LOCK_DIR);
  for (let attempt = 0; attempt < RR_LOCK_MAX_RETRIES; attempt++) {
    try {
      await mkdir(lockPath);
      try {
        return await fn();
      } finally {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > RR_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => {});
          continue;
        }
      } catch {
        // Lock may be removed/rotated between checks; keep retrying.
      }
      await new Promise((resolve) => setTimeout(resolve, RR_LOCK_RETRY_MS));
    }
  }
  throw new Error("Timed out waiting for stewardship round-robin lock");
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
  const minSafe = 64;
  if (maxChars <= minSafe) return "";
  const closingTag = "\n</goal-stewardship>";
  const body = full.endsWith(closingTag) ? full.slice(0, -closingTag.length) : full;
  const suffix = "\n…(truncated)\n</goal-stewardship>";
  const available = maxChars - suffix.length;
  if (available <= 0) return "";
  return `${body.slice(0, available)}${suffix}`;
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

  const { rrOffset, nextOff, selected } = await withRoundRobinLock(goalsDir, async () => {
    const rr = await readRoundRobin(goalsDir);
    const rot = rr.offset % candidates.length;
    const rotated = [...candidates.slice(rot), ...candidates.slice(0, rot)];
    const maxGoals = Math.min(cfg.multiGoalMaxGoals, rotated.length);
    const selectedGoals = rotated.slice(0, maxGoals);
    const next = (rot + selectedGoals.length) % Math.max(1, candidates.length);
    return { rrOffset: rr.offset, nextOff: next, selected: selectedGoals };
  });

  const weights = selected.map((g) => priorityWeight(g.priority, cfg.attentionWeights));
  const sumW = weights.reduce((a, b) => a + b, 0) || 1;
  const cap = Math.max(0, cfg.multiGoalMaxChars);
  const budgets = weights.map((w) => Math.max(1, Math.floor((w / sumW) * cap)));

  const blocks: string[] = [];
  const includedGoals: Goal[] = [];
  let suggestHeavy = opts.triageHeavy;
  const totalActive = allGoals.length;
  let remaining = cap;
  for (let i = 0; i < selected.length; i++) {
    if (remaining <= 0) break;
    const g = selected[i];
    if (!g) continue;
    const budget = Math.max(1, Math.min(remaining, budgets[i] ?? remaining));
    const block = buildStewardshipBlockCompact(g, budget, totalActive);
    if (!block) continue;
    if (block.length > remaining) break;
    blocks.push(block);
    includedGoals.push(g);
    remaining -= block.length;
    if (heuristicNeedsHeavyAttention([g])) suggestHeavy = true;
  }

  if (blocks.length === 0) return null;

  await withRoundRobinLock(goalsDir, async () => {
    await writeRoundRobin(goalsDir, { offset: nextOff });
  });

  let header = "<goal-stewardship-bundle>\n";
  header += `<!-- goals: ${includedGoals.length} | cap: ${cap} chars | rr: ${rrOffset}->${nextOff} -->\n`;
  if (opts.suggestHeavyDirective && suggestHeavy) {
    header += "<!-- triage: prefer heavy-tier model or deliberate tool use for substantive dispatch this turn -->\n";
  }
  const prepend = `${header}${blocks.join("\n\n")}\n</goal-stewardship-bundle>\n\n`;
  return { prepend, goalsIncluded: includedGoals, suggestHeavy };
}
