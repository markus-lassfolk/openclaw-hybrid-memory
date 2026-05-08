/**
 * Best-effort analysis of OpenClaw cron job messages vs goal stewardship heartbeat patterns.
 * Used by `openclaw hybrid-mem verify` (issue #1094).
 */

import type { GoalStewardshipConfig } from "../config/types/index.js";
import { getCachedMatchers } from "./goal-stewardship-heartbeat.js";

export type CronJobMessageEntry = { id: string; text: string; enabled: boolean };

/** Parse cron store JSON; extract per-job message text (payload.message or top-level message). */
export function extractCronJobMessageEntries(store: { jobs?: unknown[] } | null | undefined): CronJobMessageEntry[] {
  const out: CronJobMessageEntry[] = [];
  const rawJobs = store?.jobs;
  const jobs = Array.isArray(rawJobs) ? rawJobs : [];
  for (const j of jobs) {
    if (typeof j !== "object" || j === null) continue;
    const job = j as Record<string, unknown>;
    const id = String(job.pluginJobId ?? job.id ?? job.name ?? "unnamed");
    const payload = job.payload as Record<string, unknown> | undefined;
    const raw = payload?.message ?? job.message;
    const text = typeof raw === "string" ? raw.trim() : "";
    const enabled = typeof job.enabled === "boolean" ? job.enabled : true;
    out.push({ id, text, enabled });
  }
  return out;
}

export function textMatchesAnyHeartbeatPattern(matchers: RegExp[], userText: string): boolean {
  const t = userText.trim();
  if (!t) return false;
  return matchers.some((re) => re.test(t));
}

export interface HeartbeatCronHeuristicResult {
  /** Compiled regex count (same as matchers.length after getCachedMatchers). */
  patternCount: number;
  /** Job ids whose ENABLED job message text matches at least one pattern. */
  matchingJobIds: string[];
  /** Jobs with non-empty message that did not match. */
  nonMatchingMessageCount: number;
  /** Jobs with no message text (empty). */
  emptyMessageCount: number;
  /** Disabled job ids whose (disabled) message text matched — reported separately to avoid false-positive verification. */
  disabledMatchingJobIds: string[];
}

/**
 * Classify cron jobs against heartbeat matchers (same semantics as `matchesHeartbeat`:
 * regex test on the trimmed job message — substring match unless patterns are explicitly anchored).
 */
export function analyzeCronJobsAgainstHeartbeatPatterns(
  matchers: RegExp[],
  entries: CronJobMessageEntry[],
): HeartbeatCronHeuristicResult {
  const matchingJobIds: string[] = [];
  let nonMatchingMessageCount = 0;
  let emptyMessageCount = 0;
  const disabledMatchingJobIds: string[] = [];
  for (const e of entries) {
    if (!e.enabled) continue; // skip disabled jobs for heartbeat delivery
    if (!e.text) {
      emptyMessageCount++;
      continue;
    }
    if (textMatchesAnyHeartbeatPattern(matchers, e.text)) {
      matchingJobIds.push(e.id);
    } else {
      nonMatchingMessageCount++;
    }
  }
  // Track disabled jobs separately so they don't cause false-positive verification
  for (const e of entries) {
    if (e.enabled) continue;
    if (e.text && textMatchesAnyHeartbeatPattern(matchers, e.text)) {
      disabledMatchingJobIds.push(e.id);
    }
  }
  return {
    patternCount: matchers.length,
    matchingJobIds,
    nonMatchingMessageCount,
    emptyMessageCount,
    disabledMatchingJobIds,
  };
}

export function getHeartbeatMatchersForVerify(gs: GoalStewardshipConfig): RegExp[] {
  return getCachedMatchers(gs.heartbeatPatterns);
}
