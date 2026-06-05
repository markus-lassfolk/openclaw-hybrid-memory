/**
 * Public Artifacts Provider — registers `publicArtifacts` via
 * `api.registerMemoryCapability()` so the memory-wiki bridge can discover
 * and import hybrid-memory facts and dream reports.
 *
 * The memory-wiki bridge calls `publicArtifacts.listArtifacts()` periodically
 * to find artifacts for its Dreaming UI "Imported Insights" and "Memory Palace"
 * sections.
 *
 * Note: `registerMemoryCapability` is an exclusive slot — only one plugin can
 * own it (the plugin with `kind: "memory"` in its manifest). Since hybrid-memory
 * declares `kind: "memory"`, we should be the rightful owner.
 *
 * We provide the `publicArtifacts` field only. Other capability fields
 * (`promptBuilder`, `flushPlanResolver`, `runtime`) are optional stubs.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { MemoryEntry } from "../types/memory.js";
import { globalOnlyScopeFilter } from "../utils/scope-filter.js";
import { pluginLogger } from "../utils/logger.js";
import {
  isInternalWikiArtifact,
  isWikiExportableFact,
  wikiFactKind,
  wikiFactTitle,
  wikiFactUpdatedIso,
} from "./wiki-fact-filter.js";

export type PublicArtifact = {
  id: string;
  kind: "fact" | "dream-report" | "pattern" | "episode";
  title: string;
  content: string;
  updatedAt: string;
  metadata?: Record<string, string>;
};

export type PublicArtifactsProvider = {
  listArtifacts(opts?: { limit?: number; since?: string }): Promise<PublicArtifact[]>;
};

const DEFAULT_ARTIFACT_LIMIT = 200;

export function createPublicArtifactsProvider(factsDb: FactsDB): PublicArtifactsProvider {
  return {
    async listArtifacts(opts) {
      const limit = Math.min(opts?.limit ?? DEFAULT_ARTIFACT_LIMIT, 500);
      const sinceEpoch = opts?.since ? Math.floor(new Date(opts.since).getTime() / 1000) : undefined;

      try {
        let filtered = factsDb
          .getAll({ scopeFilter: globalOnlyScopeFilter(), includeSuperseded: false })
          .filter(isWikiExportableFact);

        if (sinceEpoch) {
          filtered = filtered.filter((f) => {
            const ts = f.lastAccessed ?? f.sourceDate ?? f.createdAt;
            return typeof ts === "number" && ts >= sinceEpoch;
          });
        }

        const sorted = filtered
          .sort((a, b) => {
            const ta = a.lastAccessed ?? a.sourceDate ?? a.createdAt;
            const tb = b.lastAccessed ?? b.sourceDate ?? b.createdAt;
            return (typeof tb === "number" ? tb : 0) - (typeof ta === "number" ? ta : 0);
          })
          .slice(0, limit);

        return sorted.map((entry): PublicArtifact => ({
          id: entry.id,
          kind: wikiFactKind(entry),
          title: wikiFactTitle(entry),
          content: entry.text,
          updatedAt: wikiFactUpdatedIso(entry),
          metadata: buildArtifactMetadata(entry),
        }));
      } catch (err) {
        pluginLogger.warn?.(
          `memory-hybrid: publicArtifacts.listArtifacts failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    },
  };
}

function buildArtifactMetadata(entry: MemoryEntry): Record<string, string> {
  return {
    category: entry.category,
    confidence: String(entry.confidence),
    source: entry.source,
    ...(entry.entity ? { entity: entry.entity } : {}),
    ...(entry.key ? { key: entry.key } : {}),
    ...(entry.tags?.length ? { tags: entry.tags.join(",") } : {}),
  };
}

/**
 * Attempt to register the publicArtifacts provider with OpenClaw's memory capability slot.
 * This is best-effort — if the API is not available or the slot is already taken,
 * registration is skipped gracefully.
 */
export function registerPublicArtifactsBestEffort(
  api: { registerMemoryCapability?: (capability: unknown) => void; logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void } },
  factsDb: FactsDB,
): boolean {
  const register = api.registerMemoryCapability;
  if (typeof register !== "function") {
    api.logger?.debug?.("memory-hybrid: api.registerMemoryCapability not available — publicArtifacts skipped");
    return false;
  }

  try {
    const provider = createPublicArtifactsProvider(factsDb);
    register({
      publicArtifacts: provider,
    });
    api.logger?.info?.("memory-hybrid: registered publicArtifacts for memory-wiki bridge import");
    return true;
  } catch (err) {
    api.logger?.warn?.(
      `memory-hybrid: registerMemoryCapability failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// Re-export for tests that assert on internal filtering.
export { isInternalWikiArtifact };
