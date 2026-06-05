/**
 * Durable parse audit for reflection maintenance tasks.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ReflectionParseLogInput = {
  task: string;
  model?: string;
  rawResponseChars: number;
  zeroReason?: string;
  stored: number;
  parseSuccess: boolean;
};

export function logReflectionParse(db: DatabaseSync, input: ReflectionParseLogInput): void {
  db.prepare(
    `INSERT INTO reflection_parse_log (id, run_at, task, model, raw_response_chars, zero_reason, stored, parse_success)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    Math.floor(Date.now() / 1000),
    input.task,
    input.model ?? null,
    input.rawResponseChars,
    input.zeroReason ?? null,
    input.stored,
    input.parseSuccess ? 1 : 0,
  );
}

export function countReflectionParseFailuresSince(db: DatabaseSync, sinceSec: number, task?: string): number {
  const row =
    task != null
      ? (db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM reflection_parse_log
             WHERE run_at >= ? AND task = ? AND parse_success = 0`,
          )
          .get(sinceSec, task) as { cnt: number } | undefined)
      : (db
          .prepare(`SELECT COUNT(*) AS cnt FROM reflection_parse_log WHERE run_at >= ? AND parse_success = 0`)
          .get(sinceSec) as { cnt: number } | undefined);
  return row?.cnt ?? 0;
}
