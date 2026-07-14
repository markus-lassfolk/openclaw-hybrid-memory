/**
 * Deterministic goal health watchdog (no LLM).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { EventLog } from "../backends/event-log.js";
import type { GoalStewardshipConfig } from "../config/types/index.js";
import { getEnv } from "../utils/env-manager.js";
import { nowIso } from "../utils/dates.js";
import { appendGoalHistory, isTerminalStatus, listGoals, readGoal, updateGoal } from "./goal-registry.js";
import type { Goal, GoalHistoryEntry, GoalPulseOutcome } from "./goal-stewardship-types.js";
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
  outcomes: Array<{
    goalId: string;
    label: string;
    outcome: GoalPulseOutcome;
    reason: string;
    taskLabel?: string;
    sessionKey?: string | null;
    runId?: string | null;
  }>;
}

interface GoalPulseOutcomeRecord {
  outcome: GoalPulseOutcome;
  reason: string;
  taskLabel?: string;
  sessionKey?: string | null;
  runId?: string | null;
}

function pulseOutcomeHistoryDetail(outcome: GoalPulseOutcomeRecord): string {
  const parts: string[] = [`outcome=${outcome.outcome}`, `reason=${outcome.reason}`];
  if (outcome.taskLabel) parts.push(`task=${outcome.taskLabel}`);
  if (outcome.sessionKey !== undefined) parts.push(`sessionKey=${outcome.sessionKey ?? "null"}`);
  if (outcome.runId !== undefined) parts.push(`runId=${outcome.runId ?? "null"}`);
  return parts.join(" | ").slice(0, 700);
}

async function persistPulseOutcomeHistory(
  goalsDir: string,
  goal: Goal,
  outcome: GoalPulseOutcomeRecord,
  logger: GoalHealthCheckOptions["logger"],
): Promise<void> {
  const detail = pulseOutcomeHistoryDetail(outcome);
  const latestPulse = [...(goal.history ?? [])].reverse().find((entry) => entry.action === "pulse-outcome");
  if (latestPulse?.detail === detail) {
    return;
  }

  const entry: GoalHistoryEntry = {
    timestamp: nowIso(),
    action: "pulse-outcome",
    detail,
    actor: "watchdog",
  };
  try {
    await appendGoalHistory(goalsDir, goal.id, entry);
  } catch (err) {
    logger.warn?.(`goal health: failed to persist pulse outcome for ${goal.label}: ${err}`);
  }
}

function extractActionableNext(goal: Goal): string | null {
  const text = goal.lastOutcome?.trim();
  if (!text) return null;
  const m = /\|\s*next:\s*(.+)$/i.exec(text);
  if (!m) return null;
  const next = m[1]?.trim() ?? "";
  if (!next) return null;
  if (/^(none|n\/a|n-a|unknown|tbd)$/i.test(next)) return null;
  return next;
}

async function findInvalidLinkedTasksReason(goalsDir: string, goalId: string): Promise<string | null> {
  const path = join(goalsDir, `${goalId}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as { linkedTasks?: unknown };
    if (!Object.hasOwn(parsed, "linkedTasks")) return null;
    if (parsed.linkedTasks === undefined || Array.isArray(parsed.linkedTasks)) return null;
    return 'Goal file has invalid "linkedTasks" field (expected array).';
  } catch {
    return null;
  }
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

export async function verifyGoalMechanically(
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
    const p = resolve(isAbsolute(v.target) ? v.target : join(workspaceRoot, v.target));
    // Reject targets that resolve outside workspaceRoot (absolute paths pointing elsewhere, or
    // relative paths using ".." to climb out) — without this, file_exists could be used to probe
    // for the presence of arbitrary files anywhere on the filesystem (e.g. ~/.ssh/id_rsa), since
    // the verification target is attacker/agent-controlled goal input.
    const rel = relative(resolve(workspaceRoot), p);
    const contained = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    if (!contained) {
      return { ok: false, detail: `file_exists: target escapes workspace (${p})` };
    }
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
      const parts = v.target.trim().split(/\s+/).filter(Boolean);
      const command = parts[0];
      if (!command) return { ok: false, detail: "command_exit_zero target is empty" };
      await execFileAsync(command, parts.slice(1), {
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
    let parsed: URL;
    try {
      parsed = new URL(v.target);
    } catch {
      return { ok: false, detail: "http_ok: target must be a valid URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, detail: "http_ok: only http/https URLs are allowed" };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, detail: "http_ok: URL credentials are not allowed" };
    }
    const hostResolution = await resolveVerificationHost(parsed.hostname);
    if (!hostResolution.allowed) {
      return { ok: false, detail: `http_ok: blocked host (${parsed.hostname}: ${hostResolution.blocked})` };
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);
    try {
      // Connect using the exact IP validated above (resolveVerificationHost), instead of letting
      // the request perform its own independent DNS resolution: a second lookup here could
      // return a different (attacker-controlled / rebound) address than the one just checked,
      // silently defeating the SSRF guard via DNS rebinding. The hostname is still sent as the
      // Host header / TLS SNI (via `parsed`), so this only pins the transport-layer address.
      const status = await fetchStatusViaPinnedIp(parsed, hostResolution.ip, ac.signal);
      return { ok: status >= 200 && status < 400, detail: `http ${status}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(t);
    }
  }
  return { ok: false, detail: "unknown verification type" };
}

function fetchStatusViaPinnedIp(parsed: URL, ip: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const requestFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestFn(
      parsed,
      {
        signal,
        lookup: (_hostname, _options, callback) => {
          callback(null, ip, isIP(ip) === 6 ? 6 : 4);
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

type VerificationHostResolution = { allowed: false; blocked: string } | { allowed: true; blocked: null; ip: string };

async function resolveVerificationHost(hostname: string): Promise<VerificationHostResolution> {
  const h = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!h) return { allowed: false, blocked: "empty host" };
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
    return { allowed: false, blocked: "local hostname" };
  }
  if (isBlockedVerificationIpLiteral(h)) return { allowed: false, blocked: "local/private IP" };
  if (isIP(h) !== 0) return { allowed: true, blocked: null, ip: h };

  let records: Array<{ address: string }>;
  try {
    records = await lookup(h, { all: true, verbatim: true });
  } catch (err) {
    return { allowed: false, blocked: `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (records.length === 0) return { allowed: false, blocked: "DNS lookup returned no addresses" };
  const blockedRecord = records.find((record) => isBlockedVerificationIpLiteral(record.address));
  if (blockedRecord) return { allowed: false, blocked: "DNS resolved to local/private IP" };
  const chosen = records[0];
  if (!chosen) return { allowed: false, blocked: "DNS lookup returned no addresses" };
  return { allowed: true, blocked: null, ip: chosen.address };
}

export async function getBlockedVerificationHostReason(hostname: string): Promise<string | null> {
  return (await resolveVerificationHost(hostname)).blocked;
}

function isBlockedVerificationIpLiteral(hostname: string): boolean {
  const ipKind = isIP(hostname);
  if (ipKind === 0) return false;
  if (ipKind === 4) return isPrivateOrLocalIpv4(hostname.split(".").map((part) => Number(part)));
  const normalized = hostname;
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(normalized)?.[1];
  if (mappedIpv4) return isPrivateOrLocalIpv4(mappedIpv4.split(".").map((part) => Number(part)));
  if (normalized.startsWith("::ffff:")) return true;
  if (normalized === "::1" || normalized === "::") return true;
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true; // unique local fc00::/7
  return false;
}

function isPrivateOrLocalIpv4(octets: number[]): boolean {
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export async function runGoalHealthCheck(opts: GoalHealthCheckOptions): Promise<GoalHealthCheckResult> {
  const { goalsDir, cfg, workspaceRoot, logger, eventLog } = opts;
  const result: GoalHealthCheckResult = { goalsChecked: 0, goalsUpdated: 0, actions: [], outcomes: [] };

  if (!cfg.enabled || !cfg.watchdogHealthCheck) {
    return result;
  }

  const goals = await listGoals(goalsDir);
  const now = Date.now();

  for (const goal of goals) {
    if (isTerminalStatus(goal.status)) continue;
    result.goalsChecked++;
    let recordedOutcome: GoalPulseOutcomeRecord | null = null;
    const recordOutcome = (
      outcome: GoalPulseOutcome,
      reason: string,
      extra?: { taskLabel?: string; sessionKey?: string | null; runId?: string | null },
    ): void => {
      recordedOutcome = {
        outcome,
        reason,
        ...(extra?.taskLabel ? { taskLabel: extra.taskLabel } : {}),
        ...(extra?.sessionKey !== undefined ? { sessionKey: extra.sessionKey } : {}),
        ...(extra?.runId !== undefined ? { runId: extra.runId } : {}),
      };
      result.outcomes.push({
        goalId: goal.id,
        label: goal.label,
        ...recordedOutcome,
      });
    };

    try {
      if (goal.dispatchCount >= goal.maxDispatches || goal.assessmentCount >= goal.maxAssessments) {
        const reason =
          goal.dispatchCount >= goal.maxDispatches
            ? `Budget exhausted: dispatches ${goal.dispatchCount}/${goal.maxDispatches}`
            : `Budget exhausted: assessments ${goal.assessmentCount}/${goal.maxAssessments}`;
        if (goal.status !== "blocked") {
          // Function-form patch: currentBlockers merges against `fresh` (re-read inside the
          // lock) instead of clobbering it from this pre-lock `goal` snapshot — a concurrent
          // writer's blocker (e.g. goal_assess) would otherwise be silently discarded.
          await updateGoal(
            goalsDir,
            goal.id,
            (fresh) => ({
              status: "blocked",
              currentBlockers: fresh.currentBlockers.includes(reason)
                ? fresh.currentBlockers
                : [...fresh.currentBlockers, reason],
            }),
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
        recordOutcome("blocked", reason);
        continue;
      }

      if (
        goal.consecutiveFailures >= goal.escalateAfterFailures &&
        (goal.status === "active" || goal.status === "stalled")
      ) {
        const escalationReason = `Escalated after ${goal.consecutiveFailures} consecutive failures`;
        // Function-form patch: currentBlockers merges against `fresh` (re-read inside the lock)
        // instead of clobbering it from this pre-lock `goal` snapshot — see the budget-exhausted
        // branch above for the same rationale.
        await updateGoal(
          goalsDir,
          goal.id,
          (fresh) => ({
            status: "blocked",
            currentBlockers: fresh.currentBlockers.includes(escalationReason)
              ? fresh.currentBlockers
              : [...fresh.currentBlockers, escalationReason],
          }),
          {
            timestamp: nowIso(),
            action: "escalated",
            detail: `${goal.consecutiveFailures} failures`,
            actor: "watchdog",
          },
        );
        result.goalsUpdated++;
        result.actions.push({ goalId: goal.id, label: goal.label, action: "escalated", reason: "failures" });
        recordOutcome("blocked", escalationReason);
        continue;
      }

      let g = await readGoal(goalsDir, goal.id);
      if (!g) {
        recordOutcome("blocked", "Goal state could not be loaded for stewardship processing.");
        continue;
      }

      const invalidLinkedTasksReason = await findInvalidLinkedTasksReason(goalsDir, goal.id);
      if (invalidLinkedTasksReason) {
        // currentBlockers/consecutiveFailures are derived from `fresh` (re-read inside
        // updateGoal's lock), not from `g` above — a concurrent goal_assess/subagent-end call
        // updating the same arrays could otherwise have its update silently reverted by this
        // patch overwriting from a stale pre-lock snapshot.
        await updateGoal(
          goalsDir,
          g.id,
          (fresh) => ({
            status: "blocked",
            currentBlockers: fresh.currentBlockers.includes(invalidLinkedTasksReason)
              ? fresh.currentBlockers
              : [...fresh.currentBlockers, invalidLinkedTasksReason],
            lastOutcome: invalidLinkedTasksReason,
            consecutiveFailures: fresh.consecutiveFailures + 1,
          }),
          {
            timestamp: nowIso(),
            action: "goal-schema-invalid",
            detail: invalidLinkedTasksReason,
            actor: "watchdog",
          },
        );
        result.goalsUpdated++;
        result.actions.push({
          goalId: g.id,
          label: g.label,
          action: "goal-schema-invalid",
          reason: invalidLinkedTasksReason,
        });
        recordOutcome("blocked", invalidLinkedTasksReason);
        continue;
      }

      let executionReason: string | null = null;
      let waitingReason: string | null = null;

      let shouldContinueToNextGoal = false;
      for (const lt of g.linkedTasks) {
        if (lt.status !== "in_progress" && lt.status !== "In progress") continue;
        const hasSession = typeof lt.sessionKey === "string" && lt.sessionKey.trim().length > 0;
        if (hasSession) continue;
        const reason = `Linked task "${lt.label}" is missing dispatch metadata (sessionKey/runId).`;
        const targetLabel = lt.label;
        // linkedTasks/currentBlockers/consecutiveFailures derived from `fresh`, not `g` — same
        // stale-array-clobber rationale as the invalidLinkedTasksReason branch above.
        await updateGoal(
          goalsDir,
          g.id,
          (fresh) => ({
            linkedTasks: fresh.linkedTasks.map((t) =>
              t.label === targetLabel
                ? {
                    ...t,
                    status: "failed",
                    dispatchFailureReason: reason,
                    updatedAt: nowIso(),
                    sessionKey: null,
                    runId: null,
                  }
                : t,
            ),
            consecutiveFailures: fresh.consecutiveFailures + 1,
            status: "blocked",
            currentBlockers: fresh.currentBlockers.includes(reason)
              ? fresh.currentBlockers
              : [...fresh.currentBlockers, reason],
            lastOutcome: reason,
          }),
          { timestamp: nowIso(), action: "dispatch-metadata-missing", detail: reason, actor: "watchdog" },
        );
        result.goalsUpdated++;
        result.actions.push({ goalId: g.id, label: g.label, action: "dispatch-metadata-missing", reason });
        recordOutcome("blocked", reason, { taskLabel: lt.label, sessionKey: null, runId: null });
        shouldContinueToNextGoal = true;
        break;
      }
      if (shouldContinueToNextGoal) continue;

      for (const lt of g.linkedTasks) {
        if (lt.status !== "in_progress" && lt.status !== "In progress") continue;
        if (!lt.sessionKey) continue;
        const pidMatch = /(?:^|:)pid[=:](\d+)/i.exec(lt.sessionKey);
        if (pidMatch) {
          const pid = Number(pidMatch[1]);
          if (!Number.isNaN(pid) && !isPidAlive(pid)) {
            const reason = `Linked task "${lt.label}" died: pid ${pid} is no longer alive`;
            const targetLabel = lt.label;
            // Same rationale as the two branches above: derive from `fresh`, not `g`.
            await updateGoal(
              goalsDir,
              g.id,
              (fresh) => ({
                linkedTasks: fresh.linkedTasks.map((t) =>
                  t.label === targetLabel ? { ...t, status: "failed", updatedAt: nowIso() } : t,
                ),
                consecutiveFailures: fresh.consecutiveFailures + 1,
                status: "blocked",
                currentBlockers: fresh.currentBlockers.includes(reason)
                  ? fresh.currentBlockers
                  : [...fresh.currentBlockers, reason],
              }),
              {
                timestamp: nowIso(),
                action: "subagent-died",
                detail: `PID ${pid} no longer alive`,
                actor: "watchdog",
              },
            );
            result.goalsUpdated++;
            result.actions.push({ goalId: g.id, label: g.label, action: "subagent-died", reason: `pid ${pid}` });
            recordOutcome("blocked", reason, {
              taskLabel: lt.label,
              sessionKey: lt.sessionKey,
              runId: lt.runId ?? null,
            });
            shouldContinueToNextGoal = true;
            const reread = await readGoal(goalsDir, goal.id);
            if (!reread) break;
            g = reread;
            break;
          }
        }
      }
      if (shouldContinueToNextGoal) continue;

      const reread2 = await readGoal(goalsDir, goal.id);
      if (!reread2) {
        recordOutcome("blocked", "Goal state disappeared during stewardship processing.");
        continue;
      }
      if (isTerminalStatus(reread2.status)) {
        recordOutcome(reread2.status === "completed" ? "done" : "noop", `Goal is already ${reread2.status}.`);
        continue;
      }
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
        waitingReason = `No activity for ${Math.round(idleMs / 60000)}m (threshold ${g.cooldownMinutes * 2}m)`;
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
        executionReason = "Activity resumed after stalled state.";
      }

      const reread3 = await readGoal(goalsDir, goal.id);
      if (!reread3) {
        recordOutcome("blocked", "Goal state disappeared during stewardship processing.");
        continue;
      }
      if (isTerminalStatus(reread3.status)) {
        recordOutcome(reread3.status === "completed" ? "done" : "noop", `Goal is already ${reread3.status}.`);
        continue;
      }
      g = reread3;
      if (reread3.status === "blocked") {
        recordOutcome("blocked", g.currentBlockers[0] ?? "Goal is blocked.");
        continue;
      }
      if (g.verification && g.verification.type !== "manual") {
        const mech = await verifyGoalMechanically(g, workspaceRoot, cfg);
        if (mech.detail !== "skip") {
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
            executionReason = `Mechanical verification passed: ${mech.detail}`;
            const rereadAfterVerify = await readGoal(goalsDir, goal.id);
            if (rereadAfterVerify) g = rereadAfterVerify;
          } else {
            // Use updateGoal (lock + fresh re-read), not a direct writeGoal(...g) spread — mechanical
            // verification can block for several seconds (command/PR/http checks), during which a
            // concurrent goal_assess could have updated blockers/circuit-breaker state; overwriting
            // the whole file from the stale pre-verification `g` snapshot would silently discard it.
            g = await updateGoal(
              goalsDir,
              g.id,
              { lastMechanicalCheck: { at: checkAt, ok: mech.ok, detail: mech.detail } },
              { timestamp: checkAt, action: "verification-checked", detail: mech.detail, actor: "watchdog" },
            );
            if (!mech.ok) waitingReason = `Mechanical verification failed: ${mech.detail}`;
          }
        }
      }

      if (g.status === "verifying" && !executionReason && !waitingReason) {
        waitingReason = "Goal is in verifying state; awaiting completion confirmation.";
      }

      const inProgress = g.linkedTasks.find((lt) => lt.status === "in_progress" || lt.status === "In progress");
      const actionableNext = extractActionableNext(g);
      if (executionReason) {
        recordOutcome("executed", executionReason);
      } else if (inProgress) {
        const hasSession = typeof inProgress.sessionKey === "string" && inProgress.sessionKey.trim().length > 0;
        if (hasSession) {
          recordOutcome("dispatched", `Task "${inProgress.label}" is in progress.`, {
            taskLabel: inProgress.label,
            sessionKey: inProgress.sessionKey ?? null,
            runId: inProgress.runId ?? null,
          });
        } else {
          recordOutcome("blocked", `Task "${inProgress.label}" has no dispatch metadata (sessionKey/runId).`, {
            taskLabel: inProgress.label,
            sessionKey: null,
            runId: null,
          });
        }
      } else if (waitingReason) {
        recordOutcome("waiting", waitingReason);
      } else if (actionableNext) {
        recordOutcome("waiting", `Actionable next step pending: ${actionableNext}`);
      } else if (g.status === "blocked") {
        recordOutcome("blocked", g.currentBlockers[0] ?? "Goal is blocked.");
      } else {
        recordOutcome("noop", "No eligible deterministic action for this goal in this pulse.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn?.(`goal health: ${goal.label} failed: ${msg}`);
      if (!recordedOutcome) {
        recordOutcome("blocked", `Goal health processing failed: ${msg.slice(0, 400)}`);
      }
    } finally {
      if (recordedOutcome) {
        await persistPulseOutcomeHistory(goalsDir, goal, recordedOutcome, logger);
      }
    }
  }

  if (result.goalsChecked > 0) {
    const summary = result.outcomes.map((o) => `${o.label}(${o.outcome})`).join(", ");
    logger.debug?.(
      `goal health: checked ${result.goalsChecked}, updated ${result.goalsUpdated}: ${summary || "no outcomes"}`,
    );
  }

  return result;
}
