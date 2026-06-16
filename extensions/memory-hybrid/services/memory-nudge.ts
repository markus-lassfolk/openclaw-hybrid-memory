/**
 * Memory nudge system (Issue #1916).
 */

import type { DatabaseSync } from "node:sqlite";
import { getSnoozeCandidates } from "./recall-signals.js";

export type MemoryNudgeConfig = {
  enabled: boolean;
  snoozeCandidateThreshold: number;
  duplicateCandidateThreshold: number;
  neverReferencedThreshold: number;
  maxTokens: number;
  throttleHours: number;
};

export const DEFAULT_MEMORY_NUDGE_CONFIG: MemoryNudgeConfig = {
  enabled: false,
  snoozeCandidateThreshold: 5,
  duplicateCandidateThreshold: 5,
  neverReferencedThreshold: 10,
  maxTokens: 200,
  throttleHours: 24,
};

export type NudgeAction = {
  label: string;
  toolCall: string;
};

export type MemoryNudgePayload = {
  actions: NudgeAction[];
};

/** Build top-3 nudge actions from vault backlog. */
export function buildMemoryNudge(db: DatabaseSync, config: MemoryNudgeConfig): MemoryNudgePayload | null {
  if (!config.enabled) return null;

  const actions: NudgeAction[] = [];
  const snoozeCandidates = getSnoozeCandidates(db);
  if (snoozeCandidates.length >= config.snoozeCandidateThreshold) {
    actions.push({
      label: `${snoozeCandidates.length} facts are surfaced often but never used`,
      toolCall: 'memory_snooze(idOrQuery="…") on stale facts',
    });
  }

  const dupRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM facts WHERE superseded_at IS NULL AND duplicate_count > 1`)
    .get() as { cnt: number } | undefined;
  const dupCount = dupRow?.cnt ?? 0;
  if (dupCount >= config.duplicateCandidateThreshold) {
    actions.push({
      label: `${dupCount} facts have near-duplicate observations`,
      toolCall: "hybrid-mem consolidate --dry-run",
    });
  }

  const neverRef = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM facts
       WHERE superseded_at IS NULL
         AND COALESCE(indexed_count, 0) >= 3
         AND COALESCE(access_count, 0) = 0`,
    )
    .get() as { cnt: number } | undefined;
  const neverRefCount = neverRef?.cnt ?? 0;
  if (neverRefCount >= config.neverReferencedThreshold) {
    actions.push({
      label: `${neverRefCount} surfaced facts were never referenced by the agent`,
      toolCall: 'memory_snooze(idOrQuery="…") on stale facts',
    });
  }

  if (actions.length === 0) return null;
  return { actions: actions.slice(0, 3) };
}

/** Format nudge as injection block (≤ maxTokens approx). */
export function formatMemoryNudgeBlock(nudge: MemoryNudgePayload, maxTokens: number = 200): string {
  const prefix = "<memory-nudge>\n";
  const suffix = "\n</memory-nudge>";
  const overheadTokens = Math.ceil((prefix.length + suffix.length) / 4);
  const availableTokens = Math.max(0, maxTokens - overheadTokens);

  const lines: string[] = [];
  let estimatedTokens = 0;

  for (let i = 0; i < nudge.actions.length; i++) {
    const line = `${i + 1}. ${nudge.actions[i].label} → ${nudge.actions[i].toolCall}`;
    const lineTokens = Math.ceil(line.length / 4);
    if (estimatedTokens + lineTokens > availableTokens && lines.length > 0) {
      break;
    }
    lines.push(line);
    estimatedTokens += lineTokens;
  }

  return `${prefix}${lines.join("\n")}${suffix}`;
}

const suppressUntilBySession = new Map<string, number>();
const lastNudgeBySession = new Map<string, number>();
const sessionLastActivity = new Map<string, number>();
const MAX_TRACKED_SESSIONS = 200;
const STALE_SESSION_TTL_MS = 30 * 60 * 1000;

function clearSessionNudgeMaps(sessionId: string): void {
  suppressUntilBySession.delete(sessionId);
  lastNudgeBySession.delete(sessionId);
  sessionLastActivity.delete(sessionId);
}

function evictOldestSession() {
  if (sessionLastActivity.size < MAX_TRACKED_SESSIONS) return;
  const oldest = sessionLastActivity.keys().next().value;
  if (oldest) clearSessionNudgeMaps(oldest);
}

/** Track session activity; evict oldest entry before admitting a new session id. */
function touchNudgeSession(sessionId: string): void {
  if (!sessionLastActivity.has(sessionId)) {
    evictOldestSession();
  }
  sessionLastActivity.set(sessionId, Date.now());
}

function sweepStaleSessions() {
  const now = Date.now();
  const cutoff = now - STALE_SESSION_TTL_MS;
  for (const [sessionId, lastActive] of sessionLastActivity) {
    if (lastActive < cutoff) {
      clearSessionNudgeMaps(sessionId);
    }
  }
}

let staleSweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureStaleSweepTimer() {
  if (staleSweepTimer === null) {
    staleSweepTimer = setInterval(sweepStaleSessions, 5 * 60 * 1000);
  }
}

export function suppressNudgeForSession(sessionId: string, hours: number): void {
  ensureStaleSweepTimer();
  touchNudgeSession(sessionId);
  suppressUntilBySession.set(sessionId, Date.now() + hours * 3600_000);
}

export function isNudgeSuppressed(sessionId: string): boolean {
  ensureStaleSweepTimer();
  touchNudgeSession(sessionId);
  const until = suppressUntilBySession.get(sessionId);
  if (!until) return false;
  if (Date.now() > until) {
    suppressUntilBySession.delete(sessionId);
    return false;
  }
  return true;
}

export function shouldEmitNudge(sessionId: string, throttleHours: number): boolean {
  ensureStaleSweepTimer();
  touchNudgeSession(sessionId);
  if (isNudgeSuppressed(sessionId)) return false;
  const last = lastNudgeBySession.get(sessionId) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed < throttleHours * 3600_000) return false;
  return true;
}

export function recordNudgeEmission(sessionId: string): void {
  ensureStaleSweepTimer();
  touchNudgeSession(sessionId);
  lastNudgeBySession.set(sessionId, Date.now());
}

/** Clear per-session nudge throttle/suppress state. */
export function clearNudgeSessionState(sessionId: string): void {
  clearSessionNudgeMaps(sessionId);
}

/** Drop expired suppress windows and nudge timestamps older than cutoff (epoch ms). */
export function sweepStaleNudgeSessionState(cutoffMs: number): number {
  const now = Date.now();
  let swept = 0;
  for (const [sessionId, until] of suppressUntilBySession) {
    if (until < now) {
      suppressUntilBySession.delete(sessionId);
      swept++;
    }
  }
  for (const [sessionId, last] of lastNudgeBySession) {
    if (last < cutoffMs) {
      lastNudgeBySession.delete(sessionId);
      swept++;
    }
  }
  return swept;
}

/** Dispose memory nudge (clear timer and state). */
export function disposeMemoryNudge(): void {
  suppressUntilBySession.clear();
  lastNudgeBySession.clear();
  sessionLastActivity.clear();
  if (staleSweepTimer !== null) {
    clearInterval(staleSweepTimer);
    staleSweepTimer = null;
  }
}

/** Clear nudge state (tests). */
export function resetNudgeState(): void {
  disposeMemoryNudge();
}

/** Test hook: count of sessions tracked in the primary activity map. */
export function _getNudgeTrackedSessionCountForTests(): number {
  return sessionLastActivity.size;
}
