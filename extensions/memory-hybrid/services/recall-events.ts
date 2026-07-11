/**
 * Structured recall event capture and JSONL backfill for reinforcement linkage.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { timestampFromFilename } from "../utils/text.js";
import { emitMemoryEvent, type RecallOccurredPayload } from "./memory-events.js";
import { parseSessionMessagesFromLines } from "./session-signal-context.js";
import {
  extractFactIdsFromToolResultPayload,
  extractRecallEventsFromMessages,
  extractRecallEventsFromTrajectoryLines,
  type ParsedRecallEvent,
  readTrajectoryLines,
} from "./session-v3-parser.js";

export type RecallEventSource = "tool" | "auto-recall" | "backfill";

export type RecallEventInput = {
  occurredAtSec?: number;
  sessionKey?: string | null;
  agentId?: string | null;
  query?: string | null;
  factIds: string[];
  hit: boolean;
  source: RecallEventSource;
  /** Optional per-fact recall scores ({ factId: score }) for the live overlay's recall pulses. */
  scores?: Record<string, number> | null;
};

/** Stable primary key for backfilled recall rows (session + occurrence + query + fact set). */
export function backfillRecallEventId(input: {
  sessionKey: string;
  occurredAtSec: number;
  query: string | null;
  factIds: string[];
}): string {
  const factSig = [...input.factIds].sort().join(",");
  const payload = `backfill\0${input.sessionKey}\0${input.occurredAtSec}\0${input.query ?? ""}\0${factSig}`;
  const hex = createHash("sha256").update(payload).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Insert a recall event; returns true when a new row was written. */
export function insertRecallEvent(db: DatabaseSync, input: RecallEventInput, opts?: { id?: string }): boolean {
  const id = opts?.id ?? randomUUID();
  const occurredAt = input.occurredAtSec ?? Math.floor(Date.now() / 1000);
  const cappedIds = [...input.factIds].sort().slice(0, 100);
  const factIdsJson = JSON.stringify(cappedIds);
  const scoresJson = serializeScores(input.scores, cappedIds);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO recall_events (id, occurred_at, session_key, agent_id, query, fact_ids, hit, source, scores)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      occurredAt,
      input.sessionKey ?? null,
      input.agentId ?? null,
      input.query ?? null,
      factIdsJson,
      input.hit ? 1 : 0,
      input.source,
      scoresJson,
    );
  return (result.changes ?? 0) > 0;
}

/** Serialize per-fact scores to JSON, restricted to the (capped) persisted fact ids. Null when absent. */
function serializeScores(scores: Record<string, number> | null | undefined, factIds: string[]): string | null {
  if (!scores) return null;
  const filtered: Record<string, number> = {};
  for (const id of factIds) {
    const s = scores[id];
    if (typeof s === "number" && Number.isFinite(s)) filtered[id] = s;
  }
  return Object.keys(filtered).length > 0 ? JSON.stringify(filtered) : null;
}

export function logRecallEvent(db: DatabaseSync, input: RecallEventInput): boolean {
  return insertRecallEvent(db, input);
}

/**
 * Persist a recall event AND broadcast it to the live Memory Graph overlay (recall pulses).
 * Use this on live recall paths (auto-recall injection, `memory_recall` tool); the emit is
 * deferred + isolated so it never affects the recall's own latency or success.
 */
export function recordRecallEvent(db: DatabaseSync, input: RecallEventInput): boolean {
  const inserted = insertRecallEvent(db, input);
  const occurredAt = input.occurredAtSec ?? Math.floor(Date.now() / 1000);
  // Build the pulsed hit set from the SAME sorted+capped id list insertRecallEvent persists, so
  // when a recall returns >100 facts the overlay pulses exactly the facts whose scores were stored
  // (not a different subset).
  const cappedIds = [...input.factIds].sort().slice(0, 100);
  const hits = cappedIds.map((factId) => ({
    factId,
    score: input.scores?.[factId] ?? 1,
  }));
  emitMemoryEvent("recallOccurred", {
    query: input.query ?? null,
    source: input.source,
    sessionKey: input.sessionKey ?? null,
    agentId: input.agentId ?? null,
    occurredAt,
    hits,
  });
  return inserted;
}

export type RecallEventRow = {
  id: string;
  occurredAt: number;
  sessionKey: string | null;
  agentId: string | null;
  query: string | null;
  factIds: string[];
  hit: boolean;
  source: RecallEventSource;
};

/**
 * Most recent recall events (newest first) with per-fact scores, shaped exactly like the live
 * `recallOccurred` payload so history reads (dashboard ActivityFeed hydration) and the live
 * subscription share one shape and one ownership gate.
 */
export function listRecentRecallEvents(db: DatabaseSync, limit = 50): RecallOccurredPayload[] {
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT occurred_at, session_key, agent_id, query, fact_ids, source, scores
       FROM recall_events ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    )
    .all(capped) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const factIds = parseFactIdsJson(String(row.fact_ids ?? "[]"));
    const scores = parseScoresJson(row.scores);
    return {
      query: row.query != null ? String(row.query) : null,
      source: String(row.source),
      sessionKey: row.session_key != null ? String(row.session_key) : null,
      agentId: row.agent_id != null ? String(row.agent_id) : null,
      occurredAt: Number(row.occurred_at),
      hits: factIds.map((factId) => ({ factId, score: scores?.[factId] ?? 1 })),
    };
  });
}

// Recent recall-event id-sets, cached per raw DB handle for 5 minutes: co-activation is computed
// on every v2-scored recall, and the underlying rows only change as fast as recalls happen.
const CO_RECALL_CACHE_TTL_MS = 5 * 60_000;
const CO_RECALL_ROW_CAP = 2_000;
// Outer WeakMap keyed by db (so cache entries are GC'd with the db handle, same as before); inner
// Map keyed by windowDays too — the query result depends on both, and today's single caller always
// passes the same windowDays, but keying on db alone would silently serve one window's rows to a
// future caller asking for a different window for up to CO_RECALL_CACHE_TTL_MS.
const coRecallCache = new WeakMap<object, Map<number, { ts: number; sets: string[][] }>>();

function recentRecallIdSets(db: DatabaseSync, windowDays: number): string[][] {
  let perDb = coRecallCache.get(db);
  const cached = perDb?.get(windowDays);
  if (cached && Date.now() - cached.ts < CO_RECALL_CACHE_TTL_MS) return cached.sets;
  const sinceSec = Math.floor(Date.now() / 1000) - windowDays * 86_400;
  const rows = db
    .prepare("SELECT fact_ids FROM recall_events WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?")
    .all(sinceSec, CO_RECALL_ROW_CAP) as Array<{ fact_ids: string }>;
  const sets = rows.map((r) => parseFactIdsJson(String(r.fact_ids ?? "[]"))).filter((ids) => ids.length >= 2);
  if (!perDb) {
    perDb = new Map();
    coRecallCache.set(db, perDb);
  }
  perDb.set(windowDays, { ts: Date.now(), sets });
  return sets;
}

/**
 * Co-activation signal for ranking: for each candidate, how many recent recall events contained it
 * TOGETHER with at least one other current candidate. Facts that history recalls as a group boost
 * each other when any of them matches again.
 */
export function countCoRecalls(db: DatabaseSync, candidateIds: string[], windowDays = 30): Map<string, number> {
  const counts = new Map<string, number>();
  if (candidateIds.length < 2) return counts;
  const wanted = new Set(candidateIds);
  for (const ids of recentRecallIdSets(db, windowDays)) {
    const present = ids.filter((id) => wanted.has(id));
    if (present.length < 2) continue;
    for (const id of present) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Parse the scores JSON column ({ factId: score }); null on absent/malformed content. */
function parseScoresJson(raw: unknown): Record<string, number> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, number> = {};
    for (const [factId, score] of Object.entries(parsed)) {
      if (typeof score === "number" && Number.isFinite(score)) out[factId] = score;
    }
    return out;
  } catch {
    return null;
  }
}

export function countRecallEventsSince(db: DatabaseSync, sinceSec: number): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM recall_events WHERE occurred_at >= ?").get(sinceSec) as
    | { cnt: number }
    | undefined;
  return row?.cnt ?? 0;
}

function parseFactIdsJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function queryRecallEventsForSession(
  db: DatabaseSync,
  sessionFileBasename: string,
  centerSec?: number,
  windowSec = 300,
): RecallEventRow[] {
  const rows =
    centerSec != null
      ? (db
          .prepare(
            `SELECT id, occurred_at, session_key, agent_id, query, fact_ids, hit, source
             FROM recall_events
             WHERE session_key = ? AND occurred_at BETWEEN ? AND ?
             ORDER BY occurred_at DESC`,
          )
          .all(sessionFileBasename, centerSec - windowSec, centerSec + windowSec) as Array<Record<string, unknown>>)
      : (db
          .prepare(
            `SELECT id, occurred_at, session_key, agent_id, query, fact_ids, hit, source
             FROM recall_events
             WHERE session_key = ?
             ORDER BY occurred_at DESC`,
          )
          .all(sessionFileBasename) as Array<Record<string, unknown>>);

  return rows.map((row) => ({
    id: String(row.id),
    occurredAt: Number(row.occurred_at),
    sessionKey: row.session_key != null ? String(row.session_key) : null,
    agentId: row.agent_id != null ? String(row.agent_id) : null,
    query: row.query != null ? String(row.query) : null,
    factIds: parseFactIdsJson(String(row.fact_ids ?? "[]")),
    hit: Number(row.hit) === 1,
    source: String(row.source) as RecallEventSource,
  }));
}

export function mergeRecallFactIdsForSession(
  db: DatabaseSync,
  sessionFileBasename: string,
  centerSec?: number,
): string[] {
  const events = queryRecallEventsForSession(db, sessionFileBasename, centerSec);
  const ids = new Set<string>();
  for (const ev of events) {
    for (const id of ev.factIds) ids.add(id);
  }
  return [...ids];
}

type ParsedRecallFromContent = {
  query?: string;
  factIds: string[];
  hit: boolean;
  toolCallId?: string;
};

/** Extract memory_recall tool_use + tool_result pairs from assistant content blocks. */
export function extractRecallEventsFromAssistantContent(content: unknown): ParsedRecallFromContent[] {
  if (!Array.isArray(content)) return [];
  const events: ParsedRecallFromContent[] = [];
  const pending = new Map<string, { query?: string }>();

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: string }).type;
    if (type === "tool_use" || type === "toolCall") {
      const name = (block as { name?: string }).name;
      if (name !== "memory_recall") continue;
      const toolId = (block as { id?: string }).id;
      const input = (block as { input?: Record<string, unknown> }).input;
      const args = (block as { arguments?: Record<string, unknown> }).arguments;
      const querySource = input ?? args;
      const query = typeof querySource?.query === "string" ? querySource.query : undefined;
      if (toolId) pending.set(toolId, { query });
      continue;
    }
    if (type === "tool_result" || type === "result") {
      const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
      if (!toolUseId || !pending.has(toolUseId)) continue;
      const meta = pending.get(toolUseId)!;
      pending.delete(toolUseId);
      const payload = (block as { content?: unknown }).content;
      const factIds = extractFactIdsFromToolResultPayload(payload, block);
      events.push({
        query: meta.query,
        factIds,
        hit: factIds.length > 0,
        toolCallId: toolUseId,
      });
    }
  }

  return events;
}

/** Collect recall events from session JSONL and optional trajectory sidecar without double-counting. */
function collectRecallEventsFromSession(
  filePath: string,
  messages: ReturnType<typeof parseSessionMessagesFromLines>,
  subsystem: string,
): ParsedRecallEvent[] {
  const seenToolCallIds = new Set<string>();
  const out: ParsedRecallEvent[] = [];
  const add = (events: Array<ParsedRecallEvent | ParsedRecallFromContent>): void => {
    for (const ev of events) {
      if (ev.toolCallId) {
        if (seenToolCallIds.has(ev.toolCallId)) continue;
        seenToolCallIds.add(ev.toolCallId);
      }
      out.push(ev);
    }
  };

  const trajLines = readTrajectoryLines(filePath);
  if (trajLines) {
    add(extractRecallEventsFromTrajectoryLines(trajLines, subsystem));
  }
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    add(extractRecallEventsFromAssistantContent(msg.content));
  }
  add(extractRecallEventsFromMessages(messages));
  return out;
}

function filenameToEpochSec(name: string, fallbackMtimeSec: number): number {
  const datePrefix = timestampFromFilename(name);
  if (datePrefix) {
    const parsed = Date.parse(`${datePrefix}T12:00:00Z`);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return fallbackMtimeSec;
}

export function backfillRecallEventsFromSessionFile(db: DatabaseSync, filePath: string): number {
  let mtimeSec = Math.floor(Date.now() / 1000);
  try {
    mtimeSec = Math.floor(statSync(filePath).mtimeMs / 1000);
  } catch {
    // use now
  }
  const sessionKey = basename(filePath);
  const occurredBase = filenameToEpochSec(sessionKey, mtimeSec);
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const messages = parseSessionMessagesFromLines(lines, "backfill-recall-events");
  let inserted = 0;
  let turnIndex = 0;

  const events = collectRecallEventsFromSession(filePath, messages, "backfill-recall-events");
  for (const ev of events) {
    turnIndex++;
    const occurredAtSec = occurredBase + turnIndex;
    const query = ev.query ?? null;
    const insertedRow = insertRecallEvent(
      db,
      {
        occurredAtSec,
        sessionKey,
        query,
        factIds: ev.factIds,
        hit: ev.hit,
        source: "backfill",
      },
      {
        id: backfillRecallEventId({ sessionKey, occurredAtSec, query, factIds: ev.factIds }),
      },
    );
    if (insertedRow) inserted++;
  }

  return inserted;
}
