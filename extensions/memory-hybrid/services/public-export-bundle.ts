import type { FactsDB } from "../backends/facts-db.js";
import type { NarrativesDB } from "../backends/narratives-db.js";
import type { Episode, MemoryEntry, ProcedureEntry, ScopeFilter } from "../types/memory.js";
import { versionInfo } from "../versionInfo.js";

export interface NarrativeExportEntry {
  id: string;
  sessionId: string;
  periodStart: number;
  periodEnd: number;
  tag: string;
  narrativeText: string;
  createdAt: number;
}

export interface PublicExportBundle {
  manifest: {
    bundleVersion: number;
    generatedAt: string;
    pluginVersion: string;
    schemaVersion: number;
    counts: {
      facts: number;
      episodes: number;
      procedures: number;
      narratives: number;
      links: number;
    };
    limits: {
      facts: number;
      episodes: number;
      procedures: number;
      narratives: number;
      links: number;
    };
  };
  version: {
    pluginVersion: string;
    schemaVersion: number;
  };
  facts: MemoryEntry[];
  episodes: Episode[];
  procedures: ProcedureEntry[];
  narratives: NarrativeExportEntry[];
  provenance: {
    links: Array<{
      source: string;
      target: string;
      linkType: string;
      strength: number;
    }>;
    bySource: Record<string, number>;
  };
}

export interface BuildPublicExportBundleOptions {
  factsLimit?: number;
  episodesLimit?: number;
  proceduresLimit?: number;
  narrativesLimit?: number;
  linksLimit?: number;
  scopeFilter?: ScopeFilter | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 2000;

function parseLimit(value: number | undefined, fallback = DEFAULT_LIMIT): number {
  if (value == null) return fallback;
  if (!Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < 1) return fallback;
  if (floored > MAX_LIMIT) return MAX_LIMIT;
  return floored;
}

function safeLoadNarratives(
  db: NarrativesDB | null,
  limit: number,
  scopeFilter: ScopeFilter | null,
): NarrativeExportEntry[] {
  if (!db) return [];
  if (!scopeFilter?.sessionId) return [];
  try {
    return db
      .listRecent(MAX_LIMIT, "all")
      .filter((n) => n.sessionId === scopeFilter.sessionId)
      .slice(0, limit)
      .map((n) => ({
        id: n.id,
        sessionId: n.sessionId,
        periodStart: n.periodStart,
        periodEnd: n.periodEnd,
        tag: n.tag,
        narrativeText: n.narrativeText,
        createdAt: n.createdAt,
      }));
  } catch (_err) {
    return [];
  }
}

export function buildPublicExportBundle(
  factsDb: FactsDB,
  narrativesDb: NarrativesDB | null,
  options: BuildPublicExportBundleOptions = {},
): PublicExportBundle {
  const factsLimit = parseLimit(options.factsLimit);
  const episodesLimit = parseLimit(options.episodesLimit);
  const proceduresLimit = parseLimit(options.proceduresLimit);
  const narrativesLimit = parseLimit(options.narrativesLimit);
  const linksLimit = parseLimit(options.linksLimit);
  const scopeFilter = options.scopeFilter ?? null;

  const facts = factsDb.getAll({ scopeFilter }).slice(0, factsLimit);
  const scopedFactIds = new Set(facts.map((f) => f.id));
  const episodes = factsDb
    .searchEpisodes({ limit: MAX_LIMIT })
    .filter((e) => {
      if (e.scope === "global") return true;
      if (e.scope === "user") return scopeFilter?.userId != null && e.scopeTarget === scopeFilter.userId;
      if (e.scope === "agent") return scopeFilter?.agentId != null && e.scopeTarget === scopeFilter.agentId;
      if (e.scope === "session") return scopeFilter?.sessionId != null && e.scopeTarget === scopeFilter.sessionId;
      return false;
    })
    .slice(0, episodesLimit);
  const procedures = factsDb
    .listProcedures(MAX_LIMIT)
    .filter((p) => {
      if (p.scope === "global") return true;
      if (p.scope === "user") return scopeFilter?.userId != null && p.scopeTarget === scopeFilter.userId;
      if (p.scope === "agent") return scopeFilter?.agentId != null && p.scopeTarget === scopeFilter.agentId;
      if (p.scope === "session") return scopeFilter?.sessionId != null && p.scopeTarget === scopeFilter.sessionId;
      return false;
    })
    .slice(0, proceduresLimit);
  const narratives = safeLoadNarratives(narrativesDb, narrativesLimit, scopeFilter);
  const rawLinks = factsDb.getAllEdges(MAX_LIMIT);
  const links = rawLinks
    .filter((l) => scopedFactIds.has(l.source) && scopedFactIds.has(l.target))
    .slice(0, linksLimit)
    .map((l) => ({
      source: l.source,
      target: l.target,
      linkType: l.linkType,
      strength: l.strength,
    }));

  return {
    manifest: {
      bundleVersion: 1,
      generatedAt: new Date().toISOString(),
      pluginVersion: versionInfo.pluginVersion,
      schemaVersion: versionInfo.schemaVersion,
      counts: {
        facts: facts.length,
        episodes: episodes.length,
        procedures: procedures.length,
        narratives: narratives.length,
        links: links.length,
      },
      limits: {
        facts: factsLimit,
        episodes: episodesLimit,
        procedures: proceduresLimit,
        narratives: narrativesLimit,
        links: linksLimit,
      },
    },
    version: {
      pluginVersion: versionInfo.pluginVersion,
      schemaVersion: versionInfo.schemaVersion,
    },
    facts,
    episodes,
    procedures,
    narratives,
    provenance: {
      links,
      bySource: facts.reduce<Record<string, number>>((acc, fact) => {
        acc[fact.source] = (acc[fact.source] ?? 0) + 1;
        return acc;
      }, {}),
    },
  };
}
