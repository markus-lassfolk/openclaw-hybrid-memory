/**
 * Per-session language metadata from runtime hooks and JSONL backfill.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { franc } from "franc";
import { parseSessionMessagesFromLines } from "./session-signal-context.js";
import { redactMaintenancePrivateText } from "../utils/maintenance-privacy.js";

const MIN_CHARS_FOR_DETECTION = 40;

export type SessionMetadataRow = {
  sessionFile: string;
  detectedLang: string;
  userCharCount: number;
  sampleSnippet: string | null;
  scannedAt: number;
};

function normalizeLang(code: string | undefined): string {
  if (!code || code === "und") return "en";
  return code.slice(0, 3).toLowerCase();
}

export function detectLanguageFromText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHARS_FOR_DETECTION) return "en";
  return normalizeLang(franc(trimmed, { minLength: MIN_CHARS_FOR_DETECTION }));
}

export function upsertSessionMetadata(db: DatabaseSync, row: SessionMetadataRow): void {
  db.prepare(
    `INSERT INTO session_metadata (session_file, detected_lang, user_char_count, sample_snippet, scanned_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_file) DO UPDATE SET
       detected_lang = excluded.detected_lang,
       user_char_count = excluded.user_char_count,
       sample_snippet = excluded.sample_snippet,
       scanned_at = excluded.scanned_at`,
  ).run(row.sessionFile, row.detectedLang, row.userCharCount, row.sampleSnippet, row.scannedAt);
}

export function getSessionLanguageHistogram(db: DatabaseSync, sinceSec?: number): Record<string, number> {
  const rows =
    sinceSec != null
      ? (db
          .prepare(
            `SELECT detected_lang, SUM(user_char_count) AS chars
             FROM session_metadata
             WHERE scanned_at >= ?
             GROUP BY detected_lang
             ORDER BY chars DESC`,
          )
          .all(sinceSec) as Array<{ detected_lang: string; chars: number }>)
      : (db
          .prepare(
            `SELECT detected_lang, SUM(user_char_count) AS chars
             FROM session_metadata
             GROUP BY detected_lang
             ORDER BY chars DESC`,
          )
          .all() as Array<{ detected_lang: string; chars: number }>);

  const out: Record<string, number> = {};
  for (const row of rows) {
    out[row.detected_lang] = Number(row.chars ?? 0);
  }
  return out;
}

export function countSessionMetadataSince(db: DatabaseSync, sinceSec: number): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM session_metadata WHERE scanned_at >= ?").get(sinceSec) as
    | { cnt: number }
    | undefined;
  return row?.cnt ?? 0;
}

export function topSessionLanguages(db: DatabaseSync, limit = 3, sinceSec?: number): string[] {
  const hist = getSessionLanguageHistogram(db, sinceSec);
  return Object.entries(hist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([lang]) => lang);
}

export function scanSessionFileForMetadata(db: DatabaseSync, filePath: string): SessionMetadataRow | null {
  let scannedAt = Math.floor(Date.now() / 1000);
  try {
    scannedAt = Math.floor(statSync(filePath).mtimeMs / 1000);
  } catch {
    // keep now
  }
  const sessionFile = basename(filePath);
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const messages = parseSessionMessagesFromLines(lines, "backfill-session-languages");
  const userTexts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user" && msg.text.trim()) userTexts.push(msg.text.trim());
  }
  if (userTexts.length === 0) return null;

  const combined = userTexts.join("\n");
  const userCharCount = combined.length;
  const detectedLang = detectLanguageFromText(combined);
  const sampleSnippet = redactMaintenancePrivateText(userTexts[0]?.slice(0, 120) ?? "").slice(0, 120) || null;
  const row: SessionMetadataRow = { sessionFile, detectedLang, userCharCount, sampleSnippet, scannedAt };
  upsertSessionMetadata(db, row);
  return row;
}

export function scanMessagesForSessionMetadata(
  db: DatabaseSync,
  sessionFile: string,
  messages: Array<{ role: string; text: string }>,
): SessionMetadataRow | null {
  const userTexts = messages.filter((m) => m.role === "user" && m.text.trim()).map((m) => m.text.trim());
  if (userTexts.length === 0) return null;
  const combined = userTexts.join("\n");
  const row: SessionMetadataRow = {
    sessionFile,
    detectedLang: detectLanguageFromText(combined),
    userCharCount: combined.length,
    sampleSnippet: redactMaintenancePrivateText(userTexts[0]?.slice(0, 120) ?? "").slice(0, 120) || null,
    scannedAt: Math.floor(Date.now() / 1000),
  };
  upsertSessionMetadata(db, row);
  return row;
}
