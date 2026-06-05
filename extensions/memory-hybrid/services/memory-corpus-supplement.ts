/**
 * MemoryCorpusSupplement — exposes hybrid-memory facts to `memory_search corpus=all`
 * and `wiki_search corpus=all` via the OpenClaw plugin SDK.
 *
 * Registered via `api.registerMemoryCorpusSupplement()` when available (OpenClaw >= 2026.6.1).
 * Non-exclusive: coexists with any other corpus supplements (e.g. memory-wiki, Hivemind).
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { MemoryEntry, ScopeFilter } from "../types/memory.js";

export type MemoryCorpusSearchResult = {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  content: string;
  score: number;
  id?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
};

export type MemoryCorpusGetResult = {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  content: string;
  fromLine: number;
  lineCount: number;
  id?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
};

export type MemoryCorpusSupplement = {
  search(params: {
    query: string;
    maxResults?: number;
    agentSessionKey?: string;
  }): Promise<MemoryCorpusSearchResult[]>;
  get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    agentSessionKey?: string;
  }): Promise<MemoryCorpusGetResult | null>;
};

const CORPUS_ID = "hybrid-memory";
const DEFAULT_MAX_RESULTS = 10;

function factVirtualPath(entry: MemoryEntry): string {
  const cat = entry.category || "uncategorized";
  return `hybrid-memory/facts/${cat}/${entry.id}`;
}

function factTitle(entry: MemoryEntry): string {
  if (entry.entity && entry.key) return `${entry.entity} / ${entry.key}`;
  if (entry.entity) return entry.entity;
  const first = entry.text.split("\n")[0]?.trim() ?? "";
  return first.length > 80 ? `${first.slice(0, 77)}...` : first || entry.id;
}

function factToContent(entry: MemoryEntry): string {
  const lines: string[] = [];
  lines.push(entry.text);
  if (entry.entity) lines.push(`\nEntity: ${entry.entity}`);
  if (entry.key) lines.push(`Key: ${entry.key}`);
  if (entry.value) lines.push(`Value: ${entry.value}`);
  lines.push(`Category: ${entry.category}`);
  lines.push(`Confidence: ${entry.confidence}`);
  if (entry.source) lines.push(`Source: ${entry.source}`);
  if (entry.tags?.length) lines.push(`Tags: ${entry.tags.join(", ")}`);
  if (entry.why) lines.push(`Why: ${entry.why}`);
  return lines.join("\n");
}

function epochToIso(epoch: number | null | undefined): string | undefined {
  if (!epoch) return undefined;
  try {
    return new Date(epoch * 1000).toISOString();
  } catch {
    return undefined;
  }
}

export interface CorpusSupplementContext {
  factsDb: FactsDB;
  scopeFilter?: ScopeFilter | null;
}

export function createMemoryCorpusSupplement(ctx: CorpusSupplementContext): MemoryCorpusSupplement {
  return {
    async search({ query, maxResults }): Promise<MemoryCorpusSearchResult[]> {
      const limit = Math.min(maxResults ?? DEFAULT_MAX_RESULTS, 50);
      if (!query?.trim()) return [];

      try {
        const results = ctx.factsDb.search(query, limit, {
          tierFilter: "all",
          scopeFilter: ctx.scopeFilter ?? null,
          deferAccessRefresh: true,
        });

        return results.map((r) => ({
          corpus: CORPUS_ID,
          path: factVirtualPath(r.entry),
          title: factTitle(r.entry),
          kind: r.entry.category,
          content: r.entry.text,
          score: r.score,
          id: r.entry.id,
          provenanceLabel: r.entry.source || undefined,
          sourceType: r.entry.category,
          updatedAt: epochToIso(r.entry.lastAccessed ?? r.entry.createdAt),
        }));
      } catch {
        return [];
      }
    },

    async get({ lookup }): Promise<MemoryCorpusGetResult | null> {
      if (!lookup?.trim()) return null;

      try {
        const factId = extractFactId(lookup);
        if (!factId) return null;

        const entry = ctx.factsDb.getById(factId);
        if (!entry) return null;

        const content = factToContent(entry);
        const lines = content.split("\n");

        return {
          corpus: CORPUS_ID,
          path: factVirtualPath(entry),
          title: factTitle(entry),
          kind: entry.category,
          content,
          fromLine: 1,
          lineCount: lines.length,
          id: entry.id,
          provenanceLabel: entry.source || undefined,
          sourceType: entry.category,
          updatedAt: epochToIso(entry.lastAccessed ?? entry.createdAt),
        };
      } catch {
        return null;
      }
    },
  };
}

function extractFactId(lookup: string): string | null {
  const trimmed = lookup.trim();

  // Direct fact ID (UUID-like or alphanumeric)
  if (/^[a-f0-9-]{8,}$/i.test(trimmed)) return trimmed;

  // Virtual path: hybrid-memory/facts/<category>/<factId>
  const pathMatch = trimmed.match(/^hybrid-memory\/facts\/[^/]+\/(.+)$/);
  if (pathMatch) return pathMatch[1];

  // Bare path with just an id suffix
  const slashParts = trimmed.split("/");
  const last = slashParts[slashParts.length - 1];
  if (last && /^[a-f0-9-]{8,}$/i.test(last)) return last;

  return null;
}
