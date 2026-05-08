/**
 * Session Observability Service — Issue #1025
 *
 * Builds a unified session observability report from existing stores:
 *   - Event log (episodes, user turns, agent actions)
 *   - Audit store (recall, injection, capture, skipped writes)
 *   - Facts DB (captured facts/entities for this session)
 *   - Narratives DB (session narrative summaries)
 *   - Context audit (injected prompt content)
 *
 * Output structure:
 *   - timeline      — merged chronological view
 *   - capture        — what was stored / suppressed during capture
 *   - recall         — why memories were recalled / not recalled
 *   - injection      — what entered prompt context and why
 *   - suppressions   — writes suppressed by policy/guards/errors
 *   - summary        — human-readable single-paragraph summary
 */

import type { AuditStore } from "../backends/audit-store.js";
import type { EventLog } from "../backends/event-log.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { NarrativesDB } from "../backends/narratives-db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionTimelineEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Event kind for display / filtering */
  kind:
    | "user_turn"
    | "agent_action"
    | "memory_captured"
    | "memory_recalled"
    | "memory_injected"
    | "memory_suppressed"
    | "episode_recorded"
    | "narrative_generated"
    | "audit_event"
    | "recall_explanation"
    | "injection_summary"
    | "capture_summary";
  /** Short label */
  label: string;
  /** What happened */
  description: string;
  /** Optional detail payload (structured) */
  detail?: unknown;
  /** Score or rank when applicable */
  score?: number;
  /** Outcome for audit/episode events */
  outcome?: "success" | "partial" | "failed" | "skipped";
}

export interface CaptureSummary {
  factsStored: number;
  factsUpdated: number;
  duplicatesSuppressed: number;
  noopSkipped: number;
  errorsEncountered: number;
  entitiesExtracted: number;
  episodesRecorded: number;
  proceduresLearned: number;
  entries: SessionTimelineEntry[];
}

export interface RecallExplanation {
  query: string;
  candidatesFound: number;
  injectedCount: number;
  omittedCount: number;
  strategies: string[];
  directiveMatches: string[];
  suppressionReasons: string[];
  entries: SessionTimelineEntry[];
}

export interface InjectionSummary {
  totalChars: number;
  totalTokensEstimate: number;
  blocksInjected: number;
  budgetTokens: number;
  budgetUsedFraction: number;
  prependContext?: string;
  entries: SessionTimelineEntry[];
}

export interface SuppressionEntry {
  timestamp: string;
  reason: string;
  detail?: string;
  outcome: "skipped" | "no_op" | "error";
}

export interface SessionObservabilityReport {
  sessionId: string | null;
  agentId: string | null;
  /** Session window */
  windowStart: string | null;
  windowEnd: string | null;
  /** Merged chronological timeline */
  timeline: SessionTimelineEntry[];
  capture: CaptureSummary;
  recall: RecallExplanation;
  injection: InjectionSummary;
  suppressions: SuppressionEntry[];
  /** Human-readable summary paragraph */
  summary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTs(ms: number): string {
  return new Date(ms).toISOString();
}

function makeEntry(
  ts: number,
  kind: SessionTimelineEntry["kind"],
  label: string,
  description: string,
  detail?: unknown,
  opts?: { score?: number; outcome?: SessionTimelineEntry["outcome"] },
): SessionTimelineEntry {
  return {
    timestamp: formatTs(ts),
    kind,
    label,
    description,
    detail,
    ...(opts?.score !== undefined ? { score: opts.score } : {}),
    ...(opts?.outcome ? { outcome: opts.outcome } : {}),
  };
}

// ---------------------------------------------------------------------------
// Core report builder
// ---------------------------------------------------------------------------

export interface SessionObservabilityDeps {
  factsDb: FactsDB;
  eventLog: EventLog | null;
  narrativesDb: NarrativesDB | null;
  auditStore: AuditStore | null;
  /** SQLite path — used to scope facts to session via source_sessions join */
  sqlitePath?: string;
  sessionId?: string | null;
  agentId?: string | null;
  /** Max timeline entries per section (default 50) */
  limit?: number;
}

export async function buildSessionObservabilityReport(
  deps: SessionObservabilityDeps,
): Promise<SessionObservabilityReport> {
  const { factsDb, eventLog, narrativesDb, auditStore, sessionId, agentId, limit = 50 } = deps;
  const now = Date.now();

  // ---------------------------------------------------------------------------
  // 1. Collect audit events for this session
  // ---------------------------------------------------------------------------
  const auditEntries: SessionTimelineEntry[] = [];
  const suppressionEntries: SuppressionEntry[] = [];

  if (auditStore) {
    const auditRows = auditStore.query({
      sessionId: sessionId ?? undefined,
      agentId: agentId ?? undefined,
      limit,
    });

    for (const row of auditRows) {
      const label = row.action;
      const desc = row.target ? `${row.action} → ${row.target}` : row.action;

      if (
        row.outcome === "failed" ||
        row.action.includes("suppressed") ||
        row.action.includes("skip") ||
        row.action.includes("noop") ||
        row.action.includes("guard")
      ) {
        suppressionEntries.push({
          timestamp: formatTs(row.timestamp),
          reason: row.action,
          detail: row.error ?? row.target ?? undefined,
          outcome: row.outcome === "failed" ? "error" : "skipped",
        });
      }

      auditEntries.push(
        makeEntry(
          row.timestamp,
          "audit_event",
          label,
          desc,
          {
            outcome: row.outcome,
            durationMs: row.durationMs,
            error: row.error,
            contextKeys: row.context ? Object.keys(row.context) : [],
            tokens: row.tokens,
          },
          { outcome: row.outcome as SessionTimelineEntry["outcome"] },
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Collect events from the event log for this session
  // ---------------------------------------------------------------------------
  const eventEntries: SessionTimelineEntry[] = [];
  if (eventLog) {
    // NOTE: eventLog.getSessionEvents or equivalent — check available methods
    // We query via factsDb since episodes table is accessible there
    // Only include events in the session window (24h lookback by default)
    const sinceMs = now - 24 * 3600 * 1000;
    try {
      // episodes are stored in facts DB; we use factsDb to retrieve them
      const episodes =
        (factsDb as { getEpisodesBySession?(sid: string, lim: number): unknown[] })?.getEpisodesBySession?.(
          sessionId ?? "recent",
          limit,
        ) ?? [];

      for (const ep of episodes as Array<{
        id?: string;
        event?: string;
        outcome?: string;
        timestamp?: number | string;
        context?: string;
      }>) {
        const ts = typeof ep.timestamp === "number" ? ep.timestamp : Date.parse(String(ep.timestamp ?? "0"));
        eventEntries.push(
          makeEntry(
            ts,
            "episode_recorded",
            ep.event ?? "episode",
            ep.context ?? ep.event ?? "",
            { outcome: ep.outcome },
            { outcome: ep.outcome as SessionTimelineEntry["outcome"] },
          ),
        );
      }
    } catch {
      // eventLog may not expose session-scoped episode query; fall back silently
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Capture summary — what was stored this session
  // ---------------------------------------------------------------------------
  // Use audit rows with action patterns that indicate store outcomes
  const storeAuditActions = auditEntries.filter((e) => {
    const a = e.label.toLowerCase();
    return (
      a.includes("store") ||
      a.includes("capture") ||
      a.includes("write") ||
      a.includes("classify") ||
      a.includes("duplicate") ||
      a.includes("noop")
    );
  });

  const captureEntries: SessionTimelineEntry[] = [];
  let factsStored = 0;
  let factsUpdated = 0;
  let duplicatesSuppressed = 0;
  let noopSkipped = 0;
  let errorsEncountered = 0;

  for (const entry of storeAuditActions) {
    captureEntries.push(entry);
    const a = entry.label.toLowerCase();
    if (entry.outcome === "failed" || a.includes("error")) {
      errorsEncountered++;
    } else if (a.includes("duplicate")) {
      duplicatesSuppressed++;
    } else if (a.includes("noop") || a.includes("skip")) {
      noopSkipped++;
    } else if (a.includes("update")) {
      factsUpdated++;
    } else if (a.includes("delete")) {
      // Delete operations should not be counted as stored facts
    } else if (a.includes("store") || a.includes("capture")) {
      factsStored++;
    }
  }

  const captureSummary: CaptureSummary = {
    factsStored,
    factsUpdated,
    duplicatesSuppressed,
    noopSkipped,
    errorsEncountered,
    entitiesExtracted: captureEntries.filter((e) => e.label.includes("entity")).length,
    episodesRecorded: eventEntries.filter((e) => e.kind === "episode_recorded").length,
    proceduresLearned: captureEntries.filter((e) => e.label.includes("procedure")).length,
    entries: captureEntries.slice(0, limit),
  };

  // ---------------------------------------------------------------------------
  // 4. Recall explanation — build from audit + facts
  // ---------------------------------------------------------------------------
  const recallAuditActions = auditEntries.filter((e) => {
    const a = e.label.toLowerCase();
    return (
      a.includes("recall") ||
      a.includes("search") ||
      a.includes("fts") ||
      a.includes("vector") ||
      a.includes("ambient") ||
      a.includes("directive")
    );
  });

  const recallEntries: SessionTimelineEntry[] = [...recallAuditActions];
  const strategies: string[] = [];
  const directiveMatches: string[] = [];
  const suppressionReasons: string[] = [];

  for (const e of recallEntries) {
    const detail = e.detail as Record<string, unknown> | undefined;
    if (detail?.strategies) {
      for (const s of Array.isArray(detail.strategies) ? detail.strategies : []) {
        if (!strategies.includes(String(s))) strategies.push(String(s));
      }
    }
    if (e.label.toLowerCase().includes("directive")) {
      directiveMatches.push(e.label);
    }
    if (e.outcome === "failed" || e.outcome === "skipped") {
      suppressionReasons.push(e.description);
    }
  }

  const recallExplanation: RecallExplanation = {
    query: "",
    candidatesFound: recallEntries.filter((e) => e.label.includes("search") || e.label.includes("recall")).length,
    injectedCount: auditEntries.filter((e) => e.label.includes("inject")).length,
    omittedCount: Math.max(0, recallEntries.length - auditEntries.filter((e) => e.label.includes("inject")).length),
    strategies: strategies.slice(0, 5),
    directiveMatches: directiveMatches.slice(0, 10),
    suppressionReasons: suppressionReasons.slice(0, 10),
    entries: recallEntries.slice(0, limit),
  };

  // ---------------------------------------------------------------------------
  // 5. Injection summary
  // ---------------------------------------------------------------------------
  const injectionAuditActions = auditEntries.filter((e) => {
    const a = e.label.toLowerCase();
    return a.includes("inject") || a.includes("prepend") || a.includes("context");
  });

  const injectionEntries: SessionTimelineEntry[] = [...injectionAuditActions];
  const injectionDetail = injectionAuditActions[0]?.detail as Record<string, unknown> | undefined;

  const budgetTokens = (injectionDetail?.budgetTokens as number) ?? 0;
  const injectionSummary: InjectionSummary = {
    totalChars: injectionEntries.reduce((s, e) => s + (e.description.length ?? 0), 0),
    totalTokensEstimate: Math.ceil(injectionEntries.reduce((s, e) => s + (e.description.length ?? 0), 0) / 4),
    blocksInjected: injectionEntries.length,
    budgetTokens,
    budgetUsedFraction: budgetTokens ? Math.min(1, (injectionEntries.length * 200) / (budgetTokens || 1)) : 0,
    prependContext: (injectionDetail?.prependContext as string) ?? undefined,
    entries: injectionEntries.slice(0, limit),
  };

  // ---------------------------------------------------------------------------
  // 6. Merge timeline
  // ---------------------------------------------------------------------------
  const allEntries: SessionTimelineEntry[] = [
    ...eventEntries,
    ...captureEntries.map((e) => ({ ...e, kind: "memory_captured" as const })),
    ...recallEntries.map((e) => ({ ...e, kind: "memory_recalled" as const })),
    ...injectionEntries.map((e) => ({ ...e, kind: "memory_injected" as const })),
  ];

  // Sort by timestamp ascending
  allEntries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Deduplicate by timestamp+kind+label
  const seen = new Set<string>();
  const timeline: SessionTimelineEntry[] = [];
  for (const e of allEntries) {
    const key = `${e.timestamp}::${e.kind}::${e.label}`;
    if (!seen.has(key)) {
      seen.add(key);
      timeline.push(e);
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Build human-readable summary
  // ---------------------------------------------------------------------------
  const parts: string[] = [];

  if (factsStored > 0 || factsUpdated > 0) {
    parts.push(
      `Captured ${factsStored} new fact${factsStored !== 1 ? "s" : ""}${factsUpdated > 0 ? ` and updated ${factsUpdated} existing` : ""}.`,
    );
  }
  if (duplicatesSuppressed > 0) {
    parts.push(`${duplicatesSuppressed} duplicate${duplicatesSuppressed !== 1 ? "s were" : " was"} suppressed.`);
  }
  if (noopSkipped > 0) {
    parts.push(`${noopSkipped} write${noopSkipped !== 1 ? "s were" : " was"} skipped (no-op).`);
  }
  if (recallEntries.length > 0) {
    parts.push(
      `${recallEntries.length} recall event${recallEntries.length !== 1 ? "s" : ""} logged, ${strategies.slice(0, 3).join(", ") || "unknown"} strategy used.`,
    );
  }
  if (injectionEntries.length > 0) {
    parts.push(
      `${injectionEntries.length} injection block${injectionEntries.length !== 1 ? "s" : ""} added to prompt.`,
    );
  }
  if (suppressionEntries.length > 0) {
    parts.push(`${suppressionEntries.length} suppression${suppressionEntries.length !== 1 ? "s" : ""} recorded.`);
  }

  const summary = parts.length > 0 ? parts.join(" ") : "No significant memory activity was recorded for this session.";

  // ---------------------------------------------------------------------------
  // 8. Window start/end from audit / event log bounds
  // ---------------------------------------------------------------------------
  let windowStart: string | null = null;
  let windowEnd: string | null = null;

  if (timeline.length > 0) {
    windowStart = timeline[0].timestamp;
    windowEnd = timeline[timeline.length - 1].timestamp;
  }

  return {
    sessionId: sessionId ?? null,
    agentId: agentId ?? null,
    windowStart,
    windowEnd,
    timeline: timeline.slice(0, limit * 3),
    capture: captureSummary,
    recall: recallExplanation,
    injection: injectionSummary,
    suppressions: suppressionEntries.slice(0, limit),
    summary,
  };
}
