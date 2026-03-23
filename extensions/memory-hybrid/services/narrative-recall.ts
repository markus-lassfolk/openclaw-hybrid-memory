import type { EventLog, EventLogEntry } from "../backends/event-log.js";
import type { NarrativesDB } from "../backends/narratives-db.js";

const DEFAULT_LOOKBACK_DAYS = 14;
const DEFAULT_SCAN_LIMIT = 24;
const DEFAULT_EVENT_LIMIT = 8;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "then",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "with",
  "you",
  "your",
]);

export interface RecallNarrativeSummariesOptions {
  narrativesDb: NarrativesDB | null;
  eventLog?: EventLog | null;
  query?: string | null;
  sessionId?: string | null;
  limit?: number;
  nowSec?: number;
  sinceSec?: number;
  scanLimit?: number;
  maxEventsPerSession?: number;
}

export interface NarrativeSummaryMatch {
  id: string;
  source: "narrative" | "event-log";
  sessionId: string;
  periodStart: number;
  periodEnd: number;
  tag: string;
  text: string;
  score: number;
}

export function formatNarrativeRange(periodStart: number, periodEnd: number): string {
  return `${new Date(periodStart * 1000).toISOString()}..${new Date(periodEnd * 1000).toISOString()}`;
}

export function recallNarrativeSummaries(options: RecallNarrativeSummariesOptions): NarrativeSummaryMatch[] {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const sinceSec = options.sessionId ? undefined : (options.sinceSec ?? nowSec - DEFAULT_LOOKBACK_DAYS * 86_400);
  const limit = Math.max(1, Math.floor(options.limit ?? 2));
  const scanLimit = Math.max(limit, Math.floor(options.scanLimit ?? DEFAULT_SCAN_LIMIT));
  const query = normalizeQuery(options.query);
  const queryTerms = tokenize(query);

  const narrativeMatches = collectNarrativeMatches(options.narrativesDb, {
    sessionId: options.sessionId ?? null,
    sinceSec,
    scanLimit,
    nowSec,
    query,
    queryTerms,
  });
  if (narrativeMatches.length > 0) {
    return narrativeMatches.slice(0, limit);
  }

  const eventMatches = collectEventMatches(options.eventLog ?? null, {
    sessionId: options.sessionId ?? null,
    sinceSec,
    limit,
    nowSec,
    query,
    queryTerms,
    maxEventsPerSession: Math.max(1, Math.floor(options.maxEventsPerSession ?? DEFAULT_EVENT_LIMIT)),
  });
  return eventMatches.slice(0, limit);
}

function collectNarrativeMatches(
  narrativesDb: NarrativesDB | null,
  options: {
    sessionId: string | null;
    sinceSec?: number;
    scanLimit: number;
    nowSec: number;
    query: string | null;
    queryTerms: string[];
  },
): NarrativeSummaryMatch[] {
  if (!narrativesDb) return [];

  const rows = options.sessionId
    ? narrativesDb.listBySession(options.sessionId, options.scanLimit, "all")
    : narrativesDb.listRecent(options.scanLimit, "all");

  return rows
    .filter((row) => options.sinceSec == null || row.periodEnd >= options.sinceSec)
    .map((row) => ({
      id: row.id,
      source: "narrative" as const,
      sessionId: row.sessionId,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      tag: row.tag,
      text: row.narrativeText,
      score: scoreCandidate(
        `${row.sessionId} ${row.tag} ${row.narrativeText}`,
        options.query,
        options.queryTerms,
        row.periodEnd,
        options.nowSec,
      ),
    }))
    .sort(compareMatches);
}

function collectEventMatches(
  eventLog: EventLog | null,
  options: {
    sessionId: string | null;
    sinceSec?: number;
    limit: number;
    nowSec: number;
    query: string | null;
    queryTerms: string[];
    maxEventsPerSession: number;
  },
): NarrativeSummaryMatch[] {
  if (!eventLog) return [];

  const sessionEvents = new Map<string, EventLogEntry[]>();
  if (options.sessionId) {
    const events = eventLog.getBySession(options.sessionId, 200);
    if (events.length > 0) sessionEvents.set(options.sessionId, events);
  } else {
    const fromIso = new Date(
      (options.sinceSec ?? options.nowSec - DEFAULT_LOOKBACK_DAYS * 86_400) * 1000,
    ).toISOString();
    const toIso = new Date(options.nowSec * 1000).toISOString();
    const maxSessions = Math.max(1, options.limit);
    const maxEventsPerSession = Math.max(1, options.maxEventsPerSession);
    const maxEventsGlobal = maxSessions * maxEventsPerSession;
    let totalEvents = 0;

    for (const event of eventLog.getByTimeRange(fromIso, toIso)) {
      // If we've already collected the maximum number of sessions, avoid
      // tracking new sessions; only accept events for sessions we know about.
      let bucket = sessionEvents.get(event.sessionId);
      if (!bucket) {
        if (sessionEvents.size >= maxSessions) {
          continue;
        }
        bucket = [];
        sessionEvents.set(event.sessionId, bucket);
      }

      // Enforce per-session and global caps on the number of events collected.
      if (bucket.length >= maxEventsPerSession) {
        continue;
      }
      if (totalEvents >= maxEventsGlobal) {
        break;
      }

      bucket.push(event);
      totalEvents += 1;

      if (totalEvents >= maxEventsGlobal && sessionEvents.size >= maxSessions) {
        break;
      }
    }
  }

  return [...sessionEvents.entries()]
    .map(([sessionId, events]) => {
      const summaryText = summarizeEvents(events, options.maxEventsPerSession);
      const first = events[0];
      const last = events[events.length - 1];
      return {
        id: `event-log:${sessionId}`,
        source: "event-log" as const,
        sessionId,
        periodStart: toSec(first?.timestamp),
        periodEnd: toSec(last?.timestamp),
        tag: "event-log",
        text: summaryText,
        score: scoreCandidate(
          `${sessionId} ${summaryText}`,
          options.query,
          options.queryTerms,
          toSec(last?.timestamp),
          options.nowSec,
        ),
      };
    })
    .filter((entry) => entry.periodEnd > 0)
    .sort(compareMatches)
    .slice(0, options.limit);
}

function summarizeEvents(events: EventLogEntry[], maxEvents: number): string {
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const parts = ordered
    .slice(0, maxEvents)
    .map(describeEvent)
    .filter((part) => part.length > 0);
  if (parts.length === 0)
    return `${ordered.length} event(s) recorded for session ${events[0]?.sessionId ?? "unknown"}.`;
  const summary = parts.join(" Then ");
  return ordered.length > maxEvents ? `${summary} Then ${ordered.length - maxEvents} more event(s) followed.` : summary;
}

function describeEvent(event: EventLogEntry): string {
  const prefix = `[${event.timestamp}]`;
  switch (event.eventType) {
    case "decision_made":
      return typeof event.content.decision === "string"
        ? `${prefix} decided ${event.content.decision}`
        : `${prefix} decision recorded`;
    case "action_taken":
      return typeof event.content.action === "string"
        ? `${prefix} tried ${event.content.action}`
        : `${prefix} action recorded`;
    case "fact_learned":
      return typeof event.content.text === "string"
        ? `${prefix} learned ${event.content.text}`
        : `${prefix} fact recorded`;
    case "entity_mentioned":
      return event.entities && event.entities.length > 0
        ? `${prefix} focused on ${event.entities.join(", ")}`
        : `${prefix} entity mentioned`;
    case "preference_expressed":
      return typeof event.content.text === "string"
        ? `${prefix} noted preference ${event.content.text}`
        : `${prefix} preference recorded`;
    case "correction":
      return typeof event.content.text === "string"
        ? `${prefix} corrected ${event.content.text}`
        : `${prefix} correction recorded`;
    default:
      return `${prefix} ${event.eventType}`;
  }
}

function scoreCandidate(
  text: string,
  query: string | null,
  queryTerms: string[],
  periodEnd: number,
  nowSec: number,
): number {
  const normalizedText = text.toLowerCase();
  const phraseBoost = query && normalizedText.includes(query) ? 2 : 0;
  const overlap =
    queryTerms.length > 0 ? queryTerms.filter((term) => normalizedText.includes(term)).length / queryTerms.length : 0;
  const ageSec = Math.max(0, nowSec - periodEnd);
  const recency = Math.max(0, 1 - ageSec / (30 * 86_400));
  return phraseBoost + overlap * 4 + recency;
}

function normalizeQuery(query: string | null | undefined): string | null {
  if (typeof query !== "string") return null;
  const trimmed = query.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function tokenize(text: string | null): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.split(/[^a-z0-9]+/)) {
    const term = raw.trim();
    if (term.length < 2 || STOP_WORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function compareMatches(a: NarrativeSummaryMatch, b: NarrativeSummaryMatch): number {
  const scoreDelta = b.score - a.score;
  if (scoreDelta !== 0) return scoreDelta;
  const timeDelta = b.periodEnd - a.periodEnd;
  if (timeDelta !== 0) return timeDelta;
  return a.sessionId.localeCompare(b.sessionId);
}

function toSec(iso: string | undefined): number {
  if (!iso) return 0;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? Math.floor(ts / 1000) : 0;
}
