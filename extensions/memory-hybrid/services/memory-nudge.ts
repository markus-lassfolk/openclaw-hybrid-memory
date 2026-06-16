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
export function formatMemoryNudgeBlock(nudge: MemoryNudgePayload): string {
  const lines = nudge.actions.map((a, i) => `${i + 1}. ${a.label} → ${a.toolCall}`);
  return `<memory-nudge>\n${lines.join("\n")}\n</memory-nudge>`;
}

const suppressUntilBySession = new Map<string, number>();
const MAX_TRACKED_SESSIONS = 200;

function evictOldestSession() {
  if (suppressUntilBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = suppressUntilBySession.keys().next().value;
    if (oldest) {
      suppressUntilBySession.delete(oldest);
      lastNudgeBySession.delete(oldest);
    }
  }
}

export function suppressNudgeForSession(sessionId: string, hours: number): void {
  evictOldestSession();
  suppressUntilBySession.set(sessionId, Date.now() + hours * 3600_000);
}

export function isNudgeSuppressed(sessionId: string): boolean {
  const until = suppressUntilBySession.get(sessionId);
  if (!until) return false;
  if (Date.now() > until) {
    suppressUntilBySession.delete(sessionId);
    return false;
  }
  return true;
}

const lastNudgeBySession = new Map<string, number>();

export function shouldEmitNudge(sessionId: string, throttleHours: number): boolean {
  if (isNudgeSuppressed(sessionId)) return false;
  const last = lastNudgeBySession.get(sessionId) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed < throttleHours * 3600_000) return false;
  return true;
}

export function recordNudgeEmission(sessionId: string): void {
  evictOldestSession();
  lastNudgeBySession.set(sessionId, Date.now());
}

/** Clear nudge state (tests). */
export function resetNudgeState(): void {
  suppressUntilBySession.clear();
  lastNudgeBySession.clear();
}
