/**
 * A-MEM-style neighbor metadata evolution (#1914).
 * Heuristic mode merges link-context keywords into neighbor tags/summary.
 * LLM mode is reserved for when lifecycle.evolution.mode=llm (future nano pass).
 */

import type { DatabaseSync } from "node:sqlite";
import type { LifecycleAdaptersConfig } from "../config/types/features.js";

export type MemoryEvolutionResult = {
  linksScanned: number;
  neighborsUpdated: number;
  llmCalls: number;
};

const STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "could",
  "should",
  "their",
  "there",
  "these",
  "those",
  "which",
  "while",
  "would",
  "memory",
  "hybrid",
]);

function extractKeywords(text: string, limit = 5): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !STOP_WORDS.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === "string");
  } catch {
    /* legacy comma-separated */
    return raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

/** Evolve neighbor metadata from recent graph links (idempotent when nothing new to merge). */
export async function runMemoryEvolutionPass(
  db: DatabaseSync,
  evolutionCfg: LifecycleAdaptersConfig["evolution"],
  opts: { llmCallsBudget?: number } = {},
): Promise<MemoryEvolutionResult> {
  const result: MemoryEvolutionResult = { linksScanned: 0, neighborsUpdated: 0, llmCalls: 0 };
  if (!evolutionCfg.enabled) return result;

  const sinceSec = Math.floor(Date.now() / 1000) - 7 * 86_400;
  const linkLimit = Math.min(200, evolutionCfg.dailyLlmCallCap * evolutionCfg.maxNeighborsPerFact);
  let links: Array<{ source_fact_id: string; target_fact_id: string }>;
  try {
    links = db
      .prepare(
        `SELECT source_fact_id, target_fact_id
         FROM memory_links
         WHERE created_at >= ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sinceSec, linkLimit) as Array<{ source_fact_id: string; target_fact_id: string }>;
  } catch {
    return result;
  }

  const getFact = db.prepare(
    `SELECT id, text, summary, tags, evolution_version
     FROM facts WHERE id = ? AND superseded_at IS NULL`,
  );
  const updateNeighbor = db.prepare(
    `UPDATE facts SET tags = ?, summary = COALESCE(?, summary),
     evolution_version = COALESCE(evolution_version, 0) + 1,
     evolution_reason = ?
     WHERE id = ?`,
  );

  const neighborBudget = new Map<string, number>();

  for (const link of links) {
    result.linksScanned++;
    const source = getFact.get(link.source_fact_id) as
      | { id: string; text: string; summary: string | null; tags: string | null; evolution_version: number }
      | undefined;
    const target = getFact.get(link.target_fact_id) as
      | { id: string; text: string; summary: string | null; tags: string | null; evolution_version: number }
      | undefined;
    if (!source || !target) continue;

    for (const neighborId of [link.target_fact_id, link.source_fact_id]) {
      const other = neighborId === link.target_fact_id ? target : source;
      const ctx = neighborId === link.target_fact_id ? source : target;
      const used = neighborBudget.get(neighborId) ?? 0;
      if (used >= evolutionCfg.maxNeighborsPerFact) continue;

      const keywords = extractKeywords(ctx.text);
      if (keywords.length === 0) continue;
      const existing = parseTags(other.tags);
      const merged = [...new Set([...existing, ...keywords])];
      if (merged.length === existing.length && other.summary?.trim()) continue;

      const summary =
        other.summary?.trim() ||
        (ctx.summary?.trim() ? ctx.summary.slice(0, 240) : ctx.text.slice(0, 240));
      const reason = `neighbor_evolution:${ctx.id}:${evolutionCfg.mode}`;
      updateNeighbor.run(JSON.stringify(merged), summary, reason, neighborId);
      neighborBudget.set(neighborId, used + 1);
      result.neighborsUpdated++;
    }
  }

  return result;
}
