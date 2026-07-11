/**
 * Morning briefing delivery (proactive research loop A4 — docs/PROACTIVE-RESEARCH.md).
 *
 * Builds the once-per-session "overnight research" block injected at the next session start and
 * flips delivered briefings' `unread` tag at build time — under-delivery on a failed injection is
 * the accepted bias (a repeat-injection loop is not). Exposure is index-only: callers route the
 * returned fact ids through refreshIndexedFacts, never refreshAccessedFacts, so surfacing a
 * briefing headline doesn't count as a recall.
 */
import type { DatabaseSync } from "node:sqlite";
import { parseTags, serializeTags } from "../utils/tags.js";
import { sanitizePromptInjection } from "./skill-prompt-injection.js";

export interface BriefingBlockResult {
  block: string;
  factIds: string[];
}

function headline(text: string, maxChars = 180): string {
  const firstLine = text.split("\n")[0] ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}

/** Unread briefings within the inject window, newest first. */
export function buildBriefingBlock(
  db: DatabaseSync,
  opts: { injectDays: number; maxBriefings: number; nowSec?: number },
): BriefingBlockResult {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (opts.injectDays <= 0 || opts.maxBriefings <= 0) return { block: "", factIds: [] };
  const rows = db
    .prepare(
      // source = 'research-executor', not just category = 'briefing': category is a caller-chosen
      // enum any memory_store call can set (e.g. a prompt-injected web page asking the agent to
      // store a "briefing"), but source is never caller-settable through the tool surface — only
      // the research CLI's single-writer store path stamps it. Trusting category alone would let
      // untrusted content re-inject itself next session under an "from your proactive research"
      // trust banner.
      `SELECT id, text FROM facts
        WHERE category = 'briefing' AND source = 'research-executor' AND superseded_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
          AND created_at >= ? AND (',' || COALESCE(tags, '') || ',') LIKE '%,unread,%'
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(nowSec, nowSec - opts.injectDays * 86_400, opts.maxBriefings) as Array<{ id: string; text: string }>;
  if (rows.length === 0) return { block: "", factIds: [] };

  const lines = rows.map((r) => `- ${sanitizePromptInjection(headline(r.text))} (full text: memory_recall id ${r.id})`);
  return {
    block: `\n🔎 Overnight research briefing (from your agent's proactive research):\n${lines.join("\n")}\n`,
    factIds: rows.map((r) => r.id),
  };
}

/** Flip `unread` → `delivered` on the given briefing facts. */
export function markBriefingsDelivered(db: DatabaseSync, factIds: string[]): void {
  if (factIds.length === 0) return;
  const select = db.prepare("SELECT tags FROM facts WHERE id = ?");
  const update = db.prepare("UPDATE facts SET tags = ? WHERE id = ?");
  for (const id of factIds) {
    const row = select.get(id) as { tags: string | null } | undefined;
    if (!row) continue;
    const tags = parseTags(row.tags).filter((t) => t !== "unread");
    if (!tags.includes("delivered")) tags.push("delivered");
    update.run(serializeTags(tags), id);
  }
}

/**
 * Undo `markBriefingsDelivered` (flip `delivered` back to `unread`). Delivery is marked at build
 * time, before the rest of the recall pipeline runs — if something downstream throws before that
 * text reaches the caller, the fact must not stay stuck as "delivered" for content the user never
 * actually saw. Under-delivery from an empty/aborted recall is an accepted bias (documented at the
 * call site); silently losing a briefing to an unrelated crash is not, so callers revert here.
 */
export function revertBriefingsDelivered(db: DatabaseSync, factIds: string[]): void {
  if (factIds.length === 0) return;
  const select = db.prepare("SELECT tags FROM facts WHERE id = ?");
  const update = db.prepare("UPDATE facts SET tags = ? WHERE id = ?");
  for (const id of factIds) {
    const row = select.get(id) as { tags: string | null } | undefined;
    if (!row) continue;
    const tags = parseTags(row.tags).filter((t) => t !== "delivered");
    if (!tags.includes("unread")) tags.push("unread");
    update.run(serializeTags(tags), id);
  }
}
