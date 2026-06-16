/**
 * A-MEM-style neighbor metadata evolution (#1914).
 * Heuristic mode merges link-context keywords into neighbor tags/summary.
 * LLM mode uses nano-tier models to refine neighbor tags and summary.
 */

import type OpenAI from "openai";
import type { DatabaseSync } from "node:sqlite";
import type { LifecycleAdaptersConfig } from "../config/types/features.js";
import { tryParseFirstJsonObject } from "../utils/llm-json-array.js";
import { CostFeature } from "./cost-feature-labels.js";
import { chatCompleteWithRetry } from "./chat.js";
import { capturePluginError } from "./error-reporter.js";

export type MemoryEvolutionResult = {
  linksScanned: number;
  neighborsUpdated: number;
  llmCalls: number;
};

export type MemoryEvolutionOpts = {
  llmCallsBudget?: number;
  openai?: OpenAI;
  nanoModels?: string[];
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
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
    return raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

type NeighborRow = {
  id: string;
  text: string;
  summary: string | null;
  tags: string | null;
};

type LlmNeighborUpdate = {
  tags: string[];
  summary: string;
};

async function evolveNeighborWithLlm(
  neighbor: NeighborRow,
  context: NeighborRow,
  opts: MemoryEvolutionOpts,
): Promise<LlmNeighborUpdate | null> {
  const { openai, nanoModels, logger } = opts;
  const model = nanoModels?.[0];
  if (!openai || !model) return null;

  const prompt =
    `You update memory neighbor metadata when two linked facts should share context.\n` +
    `Return ONLY JSON: {"tags":["kebab-case-keyword",...],"summary":"one concise sentence"}\n` +
    `Max 8 tags. Merge useful context keywords; keep existing neighbor tags when still relevant.\n\n` +
    `Neighbor fact:\n${neighbor.text.slice(0, 1200)}\n` +
    `Existing tags: ${JSON.stringify(parseTags(neighbor.tags))}\n` +
    `Existing summary: ${neighbor.summary?.trim() || "(none)"}\n\n` +
    `Linked context fact:\n${context.text.slice(0, 1200)}\n`;

  try {
    const raw = await chatCompleteWithRetry({
      openai,
      model,
      fallbackModels: nanoModels?.slice(1) ?? [],
      content: prompt,
      temperature: 0,
      maxTokens: 220,
      timeoutMs: 25_000,
      label: "memory-hybrid: evolution-neighbor",
      feature: CostFeature.evolutionPass,
    });
    const parsed = tryParseFirstJsonObject(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")) as {
      tags?: unknown;
      summary?: unknown;
    } | null;
    if (!parsed) return null;
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(0, 8)
      : [];
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 280) : "";
    if (tags.length === 0 && !summary) return null;
    return { tags, summary };
  } catch (err) {
    logger?.warn?.(`memory-hybrid: evolution LLM failed for ${neighbor.id}: ${err}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "memory-evolution",
      operation: "llm-neighbor-update",
    });
    return null;
  }
}

function applyHeuristicUpdate(
  neighbor: NeighborRow,
  context: NeighborRow,
  evolutionCfg: LifecycleAdaptersConfig["evolution"],
  updateNeighbor: { run: (...args: unknown[]) => unknown },
): boolean {
  const keywords = extractKeywords(context.text);
  if (keywords.length === 0) return false;
  const existing = parseTags(neighbor.tags);
  const merged = [...new Set([...existing, ...keywords])];
  if (merged.length === existing.length && neighbor.summary?.trim()) return false;
  const summary =
    neighbor.summary?.trim() ||
    (context.summary?.trim() ? context.summary.slice(0, 240) : context.text.slice(0, 240));
  const reason = `neighbor_evolution:${context.id}:${evolutionCfg.mode}`;
  updateNeighbor.run(JSON.stringify(merged), summary, reason, neighbor.id);
  return true;
}

/** Evolve neighbor metadata from recent graph links (idempotent when nothing new to merge). */
export async function runMemoryEvolutionPass(
  db: DatabaseSync,
  evolutionCfg: LifecycleAdaptersConfig["evolution"],
  opts: MemoryEvolutionOpts = {},
): Promise<MemoryEvolutionResult> {
  const result: MemoryEvolutionResult = { linksScanned: 0, neighborsUpdated: 0, llmCalls: 0 };
  if (!evolutionCfg.enabled) return result;

  const llmBudget = Math.min(
    evolutionCfg.dailyLlmCallCap,
    opts.llmCallsBudget ?? evolutionCfg.dailyLlmCallCap,
  );
  const useLlm = evolutionCfg.mode === "llm" && Boolean(opts.openai && opts.nanoModels?.[0]);

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
     WHERE id = ? AND id NOT IN (SELECT fact_id FROM verified_facts)`,
  );

  const neighborBudget = new Map<string, number>();

  for (const link of links) {
    result.linksScanned++;
    const source = getFact.get(link.source_fact_id) as NeighborRow | undefined;
    const target = getFact.get(link.target_fact_id) as NeighborRow | undefined;
    if (!source || !target) continue;

    for (const neighborId of [link.target_fact_id, link.source_fact_id]) {
      const other = neighborId === link.target_fact_id ? target : source;
      const ctx = neighborId === link.target_fact_id ? source : target;
      const used = neighborBudget.get(neighborId) ?? 0;
      if (used >= evolutionCfg.maxNeighborsPerFact) continue;

      let updated = false;
      if (useLlm && result.llmCalls < llmBudget) {
        const llmUpdate = await evolveNeighborWithLlm(other, ctx, opts);
        result.llmCalls++;
        if (llmUpdate) {
          const existing = parseTags(other.tags);
          const mergedTags = [...new Set([...existing, ...llmUpdate.tags])];
          const summary = llmUpdate.summary || other.summary || ctx.text.slice(0, 240);
          const reason = `neighbor_evolution:${ctx.id}:llm`;
          updateNeighbor.run(JSON.stringify(mergedTags), summary, reason, neighborId);
          updated = true;
        }
      }

      if (!updated) {
        updated = applyHeuristicUpdate(other, ctx, evolutionCfg, updateNeighbor);
      }

      if (updated) {
        neighborBudget.set(neighborId, used + 1);
        result.neighborsUpdated++;
      }
    }
  }

  if (useLlm && result.llmCalls > 0) {
    opts.logger?.info?.(
      `memory-hybrid: evolution pass updated ${result.neighborsUpdated} neighbor(s) (${result.llmCalls} LLM call(s))`,
    );
  }

  return result;
}
