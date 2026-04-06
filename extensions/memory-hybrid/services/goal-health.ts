/**
 * Deterministic goal health watchdog (no LLM).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import type { EventLog } from "../backends/event-log.js";
import type { GoalStewardshipConfig } from "../config/types/index.js";
import { getEnv } from "../utils/env-manager.js";
import { isTerminalStatus, listGoals, readGoal, updateGoal, writeGoal } from "./goal-registry.js";
import type { Goal, GoalHistoryEntry } from "./goal-stewardship-types.js";
import { isPidAlive } from "./task-queue-watchdog.js";

const execFileAsync = promisify(execFile);

export interface GoalHealthCheckOptions {
  goalsDir: string;
  cfg: GoalStewardshipConfig;
  workspaceRoot: string;
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void };
  eventLog?: EventLog | null;
}

export interface GoalHealthCheckResult {
  goalsChecked: number;
  goalsUpdated: number;
  actions: Array<{ goalId: string; label: string; action: string; reason: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

const SHELL_DENY_RE = /[;&|`$(){}!\n\\<>~#]/;

/** Parse `owner/repo#N` or a `github.com/owner/repo/pull/N` URL for pr_merged verification. */
export function parseGithubPrTarget(target: string): { owner: string; repo: string; number: number } | null {
  const t = target.trim();
  const m1 = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)#(\d+)$/.exec(t);
  if (m1) {
    const n = Number(m1[3]);
    if (!Number.isFinite(n) || n < 1) return null;
    return { owner: m1[1], repo: m1[2], number: Math.floor(n) };
  }
  const m2 = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(t);
  if (m2) {
    const n = Number(m2[3]);
    if (!Number.isFinite(n) || n < 1) return null;
    return { owner: m2[1], repo: m2[2], number: Math.floor(n) };
  }
  return null;
}

async function verifyPrMergedApi(target: string): Promise<{ ok: boolean; detail: string }> {
  const parsed = parseGithubPrTarget(target);
  if (!parsed) {
    return {
      ok: false,
      detail: "pr_merged: target must be owner/repo#N or a https://github.com/owner/repo/pull/N URL",
    };
  }
  const token = (getEnv("GITHUB_TOKEN") ?? getEnv("GH_TOKEN") ?? "").trim();
  if (!token) {
    return { ok: false, detail: "pr_merged: set GITHUB_TOKEN or GH_TOKEN for GitHub API access" };
  }
  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.status === 404) {
      return { ok: false, detail: `pr_merged: PR not found (${parsed.owner}/${parsed.repo}#${parsed.number})` };
    }
    if (!res.ok) {
      return { ok: false, detail: `pr_merged: GitHub API HTTP ${res.status}` };
    }
    const body = (await res.json()) as { merged?: boolean };
    if (body.merged === true) {
      return { ok: true, detail: `pr_merged: ${parsed.owner}/${parsed.repo}#${parsed.number} merged` };
    }
    return { ok: false, detail: `pr_merged: ${parsed.owner}/${parsed.repo}#${parsed.number} not merged yet` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(to);
  }
}

async function runMechanicalVerification(
  goal: Goal,
  workspaceRoot: string,
  cfg: GoalStewardshipConfig,
): Promise<{ ok: boolean; detail: string }> {
  const v = goal.verification;
  if (!v || v.type === "manual") {
    return { ok: false, detail: "skip" };
  }
  if (v.type === "pr_merged") {
    if (!cfg.allowPrVerification) {
      return { ok: false, detail: "pr_merged: skipped (allowPrVerification is false)" };
    }
    return verifyPrMergedApi(v.target);
  }
  if (v.type === "file_exists") {
    const p = isAbsolute(v.target) ? v.target : join(workspaceRoot, v.target);
    return { ok: existsSync(p), detail: `file_exists: ${p}` };
  }
  if (v.type === "command_exit_zero") {
    if (!cfg.allowCommandVerification) {
      return { ok: false, detail: "skip" };
    }
    if (SHELL_DENY_RE.test(v.target)) {
      return { ok: false, detail: "command_exit_zero target contains disallowed shell metacharacters" };
    }
    try {
      const parts = v.target.split(/\s+/);
      await execFileAsync(parts[0]!, parts.slice(1), {
        cwd: workspaceRoot,
        timeout: 30_000,
        shell: false,
      });
      return { ok: true, detail: `command ok: ${v.target.slice(0, 80)}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
  if (v.type === "http_ok") {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);
    try {
      const res = await fetch(v.target, { signal: ac.signal });
      return { ok: res.ok, detail: `http ${res.status}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(t);
    }
  }
  return { ok: false, detail: "unknown verification type" };
}

export async function runGoalHealthCheck(opts: GoalHealthCheckOptions): Promise<GoalHealthCheckResult> {
  const { goalsDir, cfg, workspaceRoot, logger, eventLog } = opts;
  const result: GoalHealthCheckResult = { goalsChecked: 0, goalsUpdated: 0, actions: [] };

  if (!cfg.enabled || !cfg.watchdogHealthCheck) {
    return result;
  }

  const goals = await listGoals(goalsDir);
  const now = Date.now();

  for (const goal of goals) {
    if (isTerminalStatus(goal.status)) continue;
    result.goalsChecked++;

    if (goal.dispatchCount >= goal.maxDispatches || goal.assessmentCount >= goal.maxAssessments) {
      if (goal.status !== "blocked") {
        const reason =
          goal.dispatchCount >= goal.maxDispatches
            ? `Budget exhausted: dispatches ${goal.dispatchCount}/${goal.maxDispatches}`
            : `Budget exhausted: assessments ${goal.assessmentCount}/${goal.maxAssessments}`;
        await updateGoal(
          goalsDir,
          goal.id,
          { status: "blocked", currentBlockers: [reason] },
          { timestamp: nowIso(), action: "budget-enforced", detail: reason, actor: "watchdog" },
        );
        result.goalsUpdated++;
        result.actions.push({ goalId: goal.id, label: goal.label, action: "blocked", reason });
        try {
          eventLog?.append({
            sessionId: "goal-stewardship",
            timestamp: nowIso(),
            eventType: "action_taken",
            content: {
              kind: "goal.budget_exhausted",
              goalId: goal.id,
              label: goal.label,
              type: goal.dispatchCount >= goal.maxDispatches ? "dispatches" : "assessments",
            },
          });
        } catch {
          /* non-fatal */
        }
      }
      continue;
    }

    if (
      goal.consecutiveFailures >= goal.escalateAfterFailures &&
      (goal.status === "active" || goal.status === "stalled")
    ) {
      await updateGoal(
        goalsDir,
        goal.id,
        {
          status: "blocked",
          currentBlockers: [`Escalated after ${goal.consecutiveFailures} consecutive failures`],
        },
        {
          timestamp: nowIso(),
          action: "escalated",
          detail: `${goal.consecutiveFailures} failures`,
          actor: "watchdog",
        },
      );
      result.goalsUpdated++;
      result.actions.push({ goalId: goal.id, label: goal.label, action: "escalated", reason: "failures" });
      continue;
    }

    let g = await readGoal(goalsDir, goal.id);
    if (!g) continue;
    for (const lt of g.linkedTasks) {
      if (lt.status !== "in_progress" && lt.status !== "In progress") continue;
      if (!lt.sessionKey) continue;
      const pidMatch = /(?:^|:)pid[=:](\d+)/i.exec(lt.sessionKey);
      if (pidMatch) {
        const pid = Number(pidMatch[1]);
        if (!Number.isNaN(pid) && !isPidAlive(pid)) {
          const updatedTasks = g.linkedTasks.map((t) =>
            t.label === lt.label ? { ...t, status: "failed", updatedAt: nowIso() } : t,
          );
          await updateGoal(
            goalsDir,
            g.id,
            { linkedTasks: updatedTasks, consecutiveFailures: g.consecutiveFailures + 1 },
            {
              timestamp: nowIso(),
              action: "subagent-died",
              detail: `PID ${pid} no longer alive`,
              actor: "watchdog",
            },
          );
          result.goalsUpdated++;
          result.actions.push({ goalId: g.id, label: g.label, action: "subagent-died", reason: `pid ${pid}` });
          const reread = await readGoal(goalsDir, goal.id);
          if (!reread) continue;
          g = reread;
        }
      }
    }

    const reread2 = await readGoal(goalsDir, goal.id);
    if (!reread2 || isTerminalStatus(reread2.status)) continue;
    g = reread2;

    const staleThresholdMs = g.cooldownMinutes * 2 * 60 * 1000;
    const lastActivity = g.lastAssessedAt ?? g.lastDispatchedAt ?? g.createdAt;
    const lastMs = Date.parse(lastActivity);
    const idleMs = now - (Number.isNaN(lastMs) ? now : lastMs);

    if (idleMs > staleThresholdMs && g.status === "active") {
      await updateGoal(
        goalsDir,
        g.id,
        { status: "stalled" },
        {
          timestamp: nowIso(),
          action: "stalled",
          detail: `No activity for ${Math.round(idleMs / 60000)}m (threshold ${g.cooldownMinutes * 2}m)`,
          actor: "watchdog",
        },
      );
      result.goalsUpdated++;
      result.actions.push({ goalId: g.id, label: g.label, action: "stalled", reason: "idle" });
      try {
        eventLog?.append({
          sessionId: "goal-stewardship",
          timestamp: nowIso(),
          eventType: "action_taken",
          content: { kind: "goal.stalled", goalId: g.id, label: g.label, idleMs },
        });
      } catch {
        /* non-fatal */
      }
    } else if (g.status === "stalled" && idleMs <= staleThresholdMs) {
      await updateGoal(
        goalsDir,
        g.id,
        { status: "active" },
        { timestamp: nowIso(), action: "unstalled", detail: "activity resumed", actor: "watchdog" },
      );
      result.goalsUpdated++;
      result.actions.push({ goalId: g.id, label: g.label, action: "unstalled", reason: "activity" });
    }

    const reread3 = await readGoal(goalsDir, goal.id);
    if (!reread3 || isTerminalStatus(reread3.status) || reread3.status === "blocked") continue;
    g = reread3;
    if (g.verification && g.verification.type !== "manual") {
      const mech = await runMechanicalVerification(g, workspaceRoot, cfg);
      if (mech.detail === "skip") continue;

      const checkAt = nowIso();
      if (mech.ok && (g.status === "active" || g.status === "stalled")) {
        await updateGoal(
          goalsDir,
          g.id,
          {
            status: "verifying",
            lastOutcome: mech.detail,
            lastMechanicalCheck: { at: checkAt, ok: true, detail: mech.detail },
          },
          { timestamp: checkAt, action: "verification-passed", detail: mech.detail, actor: "watchdog" },
        );
        result.goalsUpdated++;
        result.actions.push({ goalId: g.id, label: g.label, action: "verifying", reason: mech.detail });
      } else {
        await writeGoal(goalsDir, { ...g, lastMechanicalCheck: { at: checkAt, ok: mech.ok, detail: mech.detail } });
      }
    }
  }

  if (result.goalsUpdated > 0) {
    logger.debug?.(
      `goal health: checked ${result.goalsChecked}, updated ${result.goalsUpdated}: ${result.actions.map((a) => `${a.label}(${a.action})`).join(", ")}`,
    );
  }

  return result;
}
