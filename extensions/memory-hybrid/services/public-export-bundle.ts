import type { FactsDB } from "../backends/facts-db.js";
import type { NarrativesDB } from "../backends/narratives-db.js";
import type { Episode, MemoryEntry, ProcedureEntry } from "../types/memory.js";
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

function safeLoadNarratives(db: NarrativesDB | null, limit: number): NarrativeExportEntry[] {
  if (!db) return [];
  try {
    return db.listRecent(limit, "all").map((n) => ({
      id: n.id,
      sessionId: n.sessionId,
      periodStart: n.periodStart,
      periodEnd: n.periodEnd,
      tag: n.tag,
      narrativeText: n.narrativeText,
      createdAt: n.createdAt,
    }));
  } catch {
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

  const facts = factsDb.list(factsLimit);
  const episodes = factsDb.searchEpisodes({ limit: episodesLimit });
  const procedures = factsDb.listProcedures(proceduresLimit);
  const narratives = safeLoadNarratives(narrativesDb, narrativesLimit);
  const links = factsDb.getAllEdges(linksLimit);

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
      bySource: factsDb.statsBySource(),
    },
  };
}
