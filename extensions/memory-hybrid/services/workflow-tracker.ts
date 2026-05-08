/**
 * Workflow Tracker — session-level tool-sequence buffer and flush logic (Issue #209).
 *
 * Usage:
 *   1. Create: `const tracker = new WorkflowTracker(store, config)`
 *   2. Buffer: `tracker.push(toolName)` after each tool call
 *   3. Persist: `tracker.flush(goal, outcome, sessionId)` at session end
 *   4. Discard: `tracker.discard()` to clear without persisting
 *   5. Inspect: `tracker.getBuffer()` to see buffered tool names
 *
 * Privacy: only tool *names* are stored; argument values are never persisted.
 * Rate limiting: enforced per UTC calendar day, scoped to the instance.
 */

import type { WorkflowStore } from "../backends/workflow-store.js";
import { extractGoalKeywords } from "../backends/workflow-store.js";
import type { WorkflowTrackingConfig } from "../config/types/features.js";
import { capturePluginError } from "./error-reporter.js";

interface SessionBuffer {
  sessionId: string;
  toolCalls: string[];
  startedAt: number;
}

// ---------------------------------------------------------------------------
// WorkflowTracker
// ---------------------------------------------------------------------------

export class WorkflowTracker {
  private sessions = new Map<string, SessionBuffer>();

  // Instance-level rate-limit state (not module-global)
  private rateLimitDay: string;
  private rateLimitCount = 0;

  constructor(
    private readonly store: WorkflowStore,
    private readonly cfg: WorkflowTrackingConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.rateLimitDay = this.clock().toISOString().slice(0, 10);
  }

  private checkAndIncrementRateLimit(): boolean {
    const today = this.clock().toISOString().slice(0, 10);
    if (today !== this.rateLimitDay) {
      this.rateLimitDay = today;
      this.rateLimitCount = 0;
    }
    if (this.rateLimitCount >= this.cfg.maxTracesPerDay) return false;
    this.rateLimitCount++;
    return true;
  }

  /**
   * Push a tool name onto the given session's buffer.
   * No-op when tracking is disabled.
   * @param sessionId - The session identifier
   * @param toolName - The tool name to record
   * @param startTime - Optional start time in milliseconds; if provided on first push, used as startedAt
   */
  push(sessionId: string, toolName: string, startTime?: number): void {
    if (!this.cfg.enabled) return;
    let buf = this.sessions.get(sessionId);
    if (!buf) {
      buf = { sessionId, toolCalls: [], startedAt: startTime ?? this.clock().getTime() };
      this.sessions.set(sessionId, buf);
    }
    buf.toolCalls.push(toolName);
  }

  /**
   * Flush the session buffer to persistent storage.
   * Returns the recorded trace id or null if nothing was recorded.
   */
  flush(sessionId: string, goal: string, outcome: "success" | "failure" | "unknown" = "unknown"): string | null {
    if (!this.cfg.enabled) return null;
    const buf = this.sessions.get(sessionId);
    if (!buf || buf.toolCalls.length === 0) {
      this.sessions.delete(sessionId);
      return null;
    }

    // Rate limit
    if (!this.checkAndIncrementRateLimit()) {
      this.sessions.delete(sessionId);
      return null;
    }

    const durationMs = this.clock().getTime() - buf.startedAt;
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
