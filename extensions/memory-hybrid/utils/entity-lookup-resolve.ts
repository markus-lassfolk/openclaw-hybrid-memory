import type { EntityLookupConfig } from "../config/types/retrieval.js";

export type FactsDbWithKnownEntities = {
  getKnownEntities?: () => string[];
};

/**
 * Effective entity names for auto-recall entity lookup + retrieval directives.
 * Manual `entities` wins; when empty and `autoFromFacts`, use DISTINCT entity from facts (capped).
 */
export function resolveEntityLookupNames(
  entityLookup: EntityLookupConfig,
  factsDb: FactsDbWithKnownEntities,
): string[] {
  if (entityLookup.entities.length > 0) return entityLookup.entities;
  if (!entityLookup.autoFromFacts) return [];
  const raw = factsDb.getKnownEntities?.() ?? [];
  const filtered = raw.filter((e) => typeof e === "string" && e.trim().length > 0);
  return filtered.slice(0, entityLookup.maxAutoEntities);
}
