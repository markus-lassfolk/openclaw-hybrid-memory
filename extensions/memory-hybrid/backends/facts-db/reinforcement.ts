import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { capturePluginError } from "../../services/error-reporter.js";
import { createTransaction } from "../../utils/sqlite-transaction.js";
import type { ReinforcementContext, ReinforcementEvent } from "./types.js";

export function appendReinforcementQuote(existingJson: string | null, newSnippet: string): string {
  let quotes: string[] = [];
  if (existingJson) {
    try {
      const parsed = JSON.parse(existingJson);
      if (Array.isArray(parsed)) quotes = parsed.filter((q): q is string => typeof q === "string");
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "json-parse-quotes",
        severity: "info",
        subsystem: "facts",
      });
    }
  }
  quotes.push(newSnippet.slice(0, 200));
  if (quotes.length > 10) quotes = quotes.slice(-10);
  return JSON.stringify(quotes);
}

export function boostConfidence(
  db: DatabaseSync,
  id: string,
  delta: number,
  maxConfidence = 1.0,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const tx = createTransaction(db, () => {
    const row = db.prepare("SELECT confidence FROM facts WHERE id = ?").get(id) as { confidence: number } | undefined;
    if (!row) return false;

    const current = typeof row.confidence === "number" ? row.confidence : 1.0;
    const boosted = Math.min(maxConfidence, current + delta);

    db.prepare(
      "UPDATE facts SET confidence = ?, reinforced_count = reinforced_count + 1, last_reinforced_at = ? WHERE id = ?",
    ).run(boosted, nowSec, id);
    return true;
  });

  return tx() as boolean;
}

export function reinforceFact(
  db: DatabaseSync,
  id: string,
  quoteSnippet: string,
  context?: ReinforcementContext,
  opts?: { trackContext?: boolean; maxEventsPerFact?: number; boostAmount?: number },
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const trackContext = opts?.trackContext !== false;
  const maxEventsPerFact = opts?.maxEventsPerFact ?? 50;
  const boostAmount = Math.max(0, opts?.boostAmount ?? 1);

  const tx = createTransaction(db, () => {
    const row = db.prepare("SELECT reinforced_quotes FROM facts WHERE id = ?").get(id) as
      | { reinforced_quotes: string | null }
      | undefined;
    if (!row) return false;

    const quotesJson = appendReinforcementQuote(row.reinforced_quotes, quoteSnippet);

    db.prepare(
      "UPDATE facts SET reinforced_count = reinforced_count + ?, last_reinforced_at = ?, reinforced_quotes = ? WHERE id = ?",
    ).run(boostAmount, nowSec, quotesJson, id);

    if (trackContext) {
      const eventId = randomUUID();
      db.prepare(
        `INSERT INTO reinforcement_log (id, fact_id, signal, query_snippet, topic, tool_sequence, session_file, occurred_at)
         VALUES (?, ?, 'positive', ?, ?, ?, ?, ?)`,
      ).run(
        eventId,
        id,
        context?.querySnippet ?? null,
        context?.topic ?? null,
        context?.toolSequence ? JSON.stringify(context.toolSequence) : null,
        context?.sessionFile ?? null,
        nowSec,
      );

      const countRow = db.prepare("SELECT COUNT(*) as cnt FROM reinforcement_log WHERE fact_id = ?").get(id) as {
        cnt: number;
      };
      if (countRow.cnt > maxEventsPerFact) {
        db.prepare(
          `DELETE FROM reinforcement_log WHERE fact_id = ? AND id NOT IN (
             SELECT id FROM reinforcement_log WHERE fact_id = ? ORDER BY occurred_at DESC, rowid DESC LIMIT ?
           )`,
        ).run(id, id, maxEventsPerFact);
      }
    }

    return true;
  });

  return tx();
}

export function getReinforcementEvents(db: DatabaseSync, factId: string): ReinforcementEvent[] {
  const rows = db
    .prepare("SELECT * FROM reinforcement_log WHERE fact_id = ? ORDER BY occurred_at DESC")
    .all(factId) as Array<{
    id: string;
    fact_id: string;
    signal: string;
    query_snippet: string | null;
    topic: string | null;
    tool_sequence: string | null;
    session_file: string | null;
    occurred_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    factId: r.fact_id,
    signal: (r.signal === "negative" ? "negative" : "positive") as "positive" | "negative",
    querySnippet: r.query_snippet,
    topic: r.topic,
    toolSequence: r.tool_sequence ? (JSON.parse(r.tool_sequence) as string[]) : null,
    sessionFile: r.session_file,
    occurredAt: r.occurred_at,
  }));
}

export function computeDiversityFromEvents(events: ReinforcementEvent[]): number {
  if (events.length === 0) return 1.0;
  const stems = events
    .map((e) => e.querySnippet?.trim())
    .filter((s): s is string => !!s)
    .map((s) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 50),
    );
  if (stems.length === 0) return 1.0;
  const uniqueStems = new Set(stems).size;
  return uniqueStems / stems.length;
}

export function batchGetReinforcementEvents(db: DatabaseSync, factIds: string[]): Map<string, ReinforcementEvent[]> {
  if (factIds.length === 0) return new Map();
  const placeholders = factIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM reinforcement_log WHERE fact_id IN (${placeholders}) ORDER BY fact_id, occurred_at DESC`)
    .all(...factIds) as Array<{
    id: string;
    fact_id: string;
    signal: string;
    query_snippet: string | null;
    topic: string | null;
    tool_sequence: string | null;
    session_file: string | null;
    occurred_at: number;
  }>;
  const eventsByFactId = new Map<string, ReinforcementEvent[]>();
  for (const r of rows) {
    const event: ReinforcementEvent = {
      id: r.id,
      factId: r.fact_id,
      signal: (r.signal === "negative" ? "negative" : "positive") as "positive" | "negative",
      querySnippet: r.query_snippet,
      topic: r.topic,
      toolSequence: r.tool_sequence ? (JSON.parse(r.tool_sequence) as string[]) : null,
      sessionFile: r.session_file,
      occurredAt: r.occurred_at,
    };
    if (!eventsByFactId.has(r.fact_id)) {
      eventsByFactId.set(r.fact_id, []);
    }
    eventsByFactId.get(r.fact_id)?.push(event);
  }
  return eventsByFactId;
}

export function calculateDiversityScore(db: DatabaseSync, factId: string): number {
  return computeDiversityFromEvents(getReinforcementEvents(db, factId));
}

export function reinforceProcedure(
  db: DatabaseSync,
  id: string,
  quoteSnippet: string,
  promotionThreshold = 2,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const tx = createTransaction(db, () => {
    const row = db
      .prepare("SELECT reinforced_quotes, reinforced_count, confidence FROM procedures WHERE id = ?")
      .get(id) as { reinforced_quotes: string | null; reinforced_count: number; confidence: number } | undefined;
    if (!row) return false;

    const quotesJson = appendReinforcementQuote(row.reinforced_quotes, quoteSnippet);

    const newReinforcedCount = (row.reinforced_count ?? 0) + 1;

    let newConfidence = row.confidence;
    let promotedAt: number | null = null;
    if (newReinforcedCount >= promotionThreshold && row.confidence < 0.8) {
      newConfidence = Math.max(row.confidence, 0.8);
      promotedAt = nowSec;
    }

    if (promotedAt !== null) {
      db.prepare(
        "UPDATE procedures SET reinforced_count = ?, last_reinforced_at = ?, reinforced_quotes = ?, confidence = ?, promoted_at = ? WHERE id = ?",
      ).run(newReinforcedCount, nowSec, quotesJson, newConfidence, promotedAt, id);
    } else {
      db.prepare(
        "UPDATE procedures SET reinforced_count = ?, last_reinforced_at = ?, reinforced_quotes = ? WHERE id = ?",
      ).run(newReinforcedCount, nowSec, quotesJson, id);
    }
    return true;
  });

  return tx();
}
