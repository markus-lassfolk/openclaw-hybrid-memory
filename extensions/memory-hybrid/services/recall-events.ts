/**
 * Structured recall event capture and JSONL backfill for reinforcement linkage.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type ParsedRecallEvent,
  extractRecallEventsFromMessages,
  extractRecallEventsFromTrajectoryLines,
  readTrajectoryLines,
} from "./session-v3-parser.js";
import { extractRecalledMemoryIds, parseSessionMessagesFromLines } from "./session-signal-context.js";
import { timestampFromFilename } from "../utils/text.js";

export type RecallEventSource = "tool" | "auto-recall" | "backfill";

export type RecallEventInput = {
  occurredAtSec?: number;
  sessionKey?: string | null;
  agentId?: string | null;
  query?: string | null;
  factIds: string[];
  hit: boolean;
  source: RecallEventSource;
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
  const factIdsJson = JSON.stringify([...input.factIds].sort().slice(0, 100));
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO recall_events (id, occurred_at, session_key, agent_id, query, fact_ids, hit, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
  return (result.changes ?? 0) > 0;
}

export function logRecallEvent(db: DatabaseSync, input: RecallEventInput): boolean {
  return insertRecallEvent(db, input);
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
      const factIds = extractRecalledMemoryIds([block]);
      events.push({
        query: meta.query,
        factIds,
        hit: factIds.length > 0,
      });
    }
  }

  return events;
}

function recallEventFingerprint(ev: ParsedRecallEvent): string {
  return `${ev.query ?? ""}\0${[...ev.factIds].sort().join(",")}\0${ev.hit ? 1 : 0}`;
}

/** Collect recall events from session JSONL and optional trajectory sidecar without double-counting. */
function collectRecallEventsFromSession(
  filePath: string,
  messages: ReturnType<typeof parseSessionMessagesFromLines>,
  subsystem: string,
): ParsedRecallEvent[] {
  const seen = new Set<string>();
  const out: ParsedRecallEvent[] = [];
  const add = (events: ParsedRecallEvent[]): void => {
    for (const ev of events) {
      const fp = recallEventFingerprint(ev);
      if (seen.has(fp)) continue;
      seen.add(fp);
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
