/**
 * Pure SQL / FTS query fragments for FactsDB (#870, #888).
 */

import type { DatabaseSync } from "node:sqlite";
import { sanitizeFts5QueryForFacts } from "./fts-text.js";

/** Load superseded fact texts (lowercased) for LanceDB overlap filtering. */
export function fetchSupersededFactTextsLower(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT text FROM facts WHERE superseded_at IS NOT NULL").all() as Array<{ text: string }>;
  return rows.map((r) => r.text.toLowerCase());
}

/**
 * OR-joined quoted FTS terms (+ optional prefix terms) for classification-style lookups (#898 alignment with porter).
 */
/** Broader OR clause for `FactsDB.search()` (min term length 1, all tokens, porter prefix). */
export function buildFactsSearchFtsOrClause(query: string, options?: { maxOrTerms?: number }): string | null {
  const sanitized = sanitizeFts5QueryForFacts(query);
  let terms = sanitized.split(/\s+/).filter((w) => w.length > 1);
  const cap = options?.maxOrTerms;
  if (cap !== undefined && cap > 0 && terms.length > cap) {
    terms = terms.slice(0, cap);
  }
  if (terms.length === 0) return null;
  const parts = terms.map((w) => {
    if (/^[a-zA-Z0-9_]+$/.test(w) && w.length >= 3) {
      return `( "${w}" OR ${w}* )`;
    }
    return `"${w}"`;
  });
  return parts.join(" OR ");
}

export function buildClassificationFtsOrClause(rawText: string): string | null {
  const sanitized = sanitizeFts5QueryForFacts(rawText);
  const parts = sanitized
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 5)
    .map((w) => {
      if (/^[a-zA-Z0-9_]+$/.test(w) && w.length >= 3) {
        return `( "${w}" OR ${w}* )`;
      }
      return `"${w}"`;
    });
  if (parts.length === 0) return null;
  return parts.join(" OR ");
}
