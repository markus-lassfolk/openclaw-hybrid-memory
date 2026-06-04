/**
 * Structured recall event capture and JSONL backfill for reinforcement linkage.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
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

export function logRecallEvent(db: DatabaseSync, input: RecallEventInput): void {
  const id = randomUUID();
  const occurredAt = input.occurredAtSec ?? Math.floor(Date.now() / 1000);
  const factIdsJson = JSON.stringify(input.factIds.slice(0, 100));
  db.prepare(
    `INSERT INTO recall_events (id, occurred_at, session_key, agent_id, query, fact_ids, hit, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    occurredAt,
    input.sessionKey ?? null,
    input.agentId ?? null,
    input.query ?? null,
    factIdsJson,
    input.hit ? 1 : 0,
    input.source,
  );
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

  const logParsedEvents = (events: ReturnType<typeof extractRecallEventsFromMessages>): void => {
    for (const ev of events) {
      turnIndex++;
      logRecallEvent(db, {
        occurredAtSec: occurredBase + turnIndex,
        sessionKey,
        query: ev.query ?? null,
        factIds: ev.factIds,
        hit: ev.hit,
        source: "backfill",
      });
      inserted++;
    }
  };

  const trajLines = readTrajectoryLines(filePath);
  if (trajLines) {
    logParsedEvents(extractRecallEventsFromTrajectoryLines(trajLines, "backfill-recall-events"));
  } else {
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const inline = extractRecallEventsFromAssistantContent(msg.content);
      logParsedEvents(inline);
    }

    logParsedEvents(extractRecallEventsFromMessages(messages));
  }

  return inserted;
}
