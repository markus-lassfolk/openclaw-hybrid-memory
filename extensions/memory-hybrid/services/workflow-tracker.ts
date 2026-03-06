/**
 * Workflow Tracker — session-level tool-sequence buffer and flush logic (Issue #209).
 *
 * Usage:
 *   1. Call `trackerForSession(sessionId)` to get/create a per-session buffer.
 *   2. Call `buffer.push(toolName)` after each tool call.
 *   3. Call `flush(goal, outcome)` at session end (or on explicit request) to
 *      persist the trace to WorkflowStore.
 *
 * Privacy: only tool *names* are stored; argument values are never persisted.
 * Rate limiting: enforced per UTC calendar day across all sessions.
 */

import { capturePluginError } from "./error-reporter.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import { extractGoalKeywords } from "../backends/workflow-store.js";
import type { WorkflowTrackingConfig } from "../config/types/features.js";

export interface SessionBuffer {
  sessionId: string;
  toolCalls: string[];
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Simple in-memory rate-limiter: count traces persisted per UTC day
// ---------------------------------------------------------------------------

let currentDay = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
let todayCount = 0;

function checkAndIncrementRateLimit(maxPerDay: number): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentDay) {
    currentDay = today;
    todayCount = 0;
  }
  if (todayCount >= maxPerDay) return false;
  todayCount++;
  return true;
}

/** Exported for tests only */
export function _resetRateLimitForTest(): void {
  currentDay = new Date().toISOString().slice(0, 10);
  todayCount = 0;
}

// ---------------------------------------------------------------------------
// WorkflowTracker
// ---------------------------------------------------------------------------

export class WorkflowTracker {
  private sessions = new Map<string, SessionBuffer>();

  constructor(
    private readonly store: WorkflowStore,
    private readonly cfg: WorkflowTrackingConfig,
  ) {}

  /**
   * Push a tool name onto the given session's buffer.
   * No-op when tracking is disabled.
   */
  push(sessionId: string, toolName: string): void {
    if (!this.cfg.enabled) return;
    let buf = this.sessions.get(sessionId);
    if (!buf) {
      buf = { sessionId, toolCalls: [], startedAt: Date.now() };
      this.sessions.set(sessionId, buf);
    }
    buf.toolCalls.push(toolName);
  }

  /**
   * Flush the session buffer to persistent storage.
   * Returns the recorded trace id or null if nothing was recorded.
   */
  flush(
    sessionId: string,
    goal: string,
    outcome: "success" | "failure" | "unknown" = "unknown",
  ): string | null {
    if (!this.cfg.enabled) return null;
    const buf = this.sessions.get(sessionId);
    if (!buf || buf.toolCalls.length === 0) {
      this.sessions.delete(sessionId);
      return null;
    }

    // Rate limit
    if (!checkAndIncrementRateLimit(this.cfg.maxTracesPerDay)) {
      this.sessions.delete(sessionId);
      return null;
    }

    const durationMs = Date.now() - buf.startedAt;
    const goalKeywords = extractGoalKeywords(goal);

    try {
      const trace = this.store.record({
        goal,
        goalKeywords,
        toolSequence: buf.toolCalls,
        outcome,
        durationMs,
        sessionId,
      });
      this.sessions.delete(sessionId);
      return trace.id;
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "workflow-flush",
        subsystem: "workflow-tracker",
      });
      this.sessions.delete(sessionId);
      return null;
    }
  }

  /**
   * Discard (without saving) the session buffer.
   */
  discard(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Snapshot of the current tool sequence for a session (for tests / inspection).
   */
  getBuffer(sessionId: string): string[] {
    return this.sessions.get(sessionId)?.toolCalls ?? [];
  }

  /**
   * Run auto-prune based on retentionDays config. Call this during nightly cycle.
   */
  prune(): number {
    if (!this.cfg.enabled || this.cfg.retentionDays <= 0) return 0;
    try {
      return this.store.prune(this.cfg.retentionDays);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "workflow-prune",
        subsystem: "workflow-tracker",
      });
      return 0;
    }
  }
}
