import type { DatabaseSync } from "node:sqlite";

export type FactProvenanceJson = Record<string, unknown> & {
  sourceFactIds?: string[];
  sourceEventIds?: string[];
  sourceFacts?: Array<{ id: string; text?: string; source?: string | null; category?: string | null }>;
  sourceEvents?: Array<Record<string, unknown>>;
  consolidatedAt?: number;
  method?: string;
};

function parseProvenance(raw: string | null | undefined): FactProvenanceJson {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as FactProvenanceJson) : {};
  } catch {
    return {};
  }
}

function uniq(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0))];
}

export function mergeFactProvenanceJson(existingRaw: string | null | undefined, patch: FactProvenanceJson): string {
  const existing = parseProvenance(existingRaw);
  const merged: FactProvenanceJson = { ...existing, ...patch };

  merged.sourceFactIds = uniq([...(existing.sourceFactIds ?? []), ...(patch.sourceFactIds ?? [])]);
  merged.sourceEventIds = uniq([...(existing.sourceEventIds ?? []), ...(patch.sourceEventIds ?? [])]);

  const factRows = [...(existing.sourceFacts ?? []), ...(patch.sourceFacts ?? [])];
  if (factRows.length > 0) {
    const byId = new Map<string, { id: string; text?: string; source?: string | null; category?: string | null }>();
    for (const row of factRows) {
      if (!row || typeof row.id !== "string" || row.id.length === 0) continue;
      byId.set(row.id, { ...byId.get(row.id), ...row });
    }
    merged.sourceFacts = [...byId.values()];
  }

  const eventRows = [...(existing.sourceEvents ?? []), ...(patch.sourceEvents ?? [])];
  if (eventRows.length > 0) {
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of eventRows) {
      const id = typeof row?.id === "string" ? row.id : undefined;
      if (!id) continue;
      byId.set(id, { ...byId.get(id), ...row });
    }
    merged.sourceEvents = [...byId.values()];
  }

  if (merged.sourceFactIds.length === 0) merged.sourceFactIds = undefined;
  if (merged.sourceEventIds.length === 0) merged.sourceEventIds = undefined;
  return JSON.stringify(merged);
}

export function appendFactProvenance(db: DatabaseSync, factId: string, patch: FactProvenanceJson): void {
  const row = db.prepare("SELECT provenance_json FROM facts WHERE id = ?").get(factId) as
    | { provenance_json: string | null }
    | undefined;
  if (!row) return;
  db.prepare("UPDATE facts SET provenance_json = ? WHERE id = ?").run(
    mergeFactProvenanceJson(row.provenance_json, patch),
    factId,
  );
}

export function parseFactProvenanceJson(raw: string | null | undefined): FactProvenanceJson {
  return parseProvenance(raw);
}

export type ProvenanceSourceFactSummary = {
  id: string;
  text: string;
  category?: string | null;
  source?: string | null;
};

type ProvenanceFactLookup = {
  getById(
    id: string,
  ): {
    id: string;
    text: string;
    category?: string;
    source?: string;
    supersededAt?: number | null;
    expiresAt?: number | null;
  } | null;
};

/**
 * Resolve source facts for consolidated/derived facts (for recall hydration).
 */
export function resolveProvenanceSourceFacts(
  factsDb: ProvenanceFactLookup,
  provenance: FactProvenanceJson,
  limit = 5,
): ProvenanceSourceFactSummary[] {
  const out: ProvenanceSourceFactSummary[] = [];
  const seen = new Set<string>();
  const nowSec = Math.floor(Date.now() / 1000);

  function isLiveFact(entry: { supersededAt?: number | null; expiresAt?: number | null }): boolean {
    return entry.supersededAt == null && (entry.expiresAt == null || entry.expiresAt > nowSec);
  }

  if (provenance.sourceFacts?.length) {
    for (const row of provenance.sourceFacts) {
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      const entry = factsDb.getById(row.id);
      if (!entry || !isLiveFact(entry)) continue;
      out.push({
        id: row.id,
        text: entry.text,
        category: row.category,
        source: row.source,
      });
      if (out.length >= limit) return out;
    }
  }

  for (const id of provenance.sourceFactIds ?? []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = factsDb.getById(id);
    if (!entry || !isLiveFact(entry)) continue;
    out.push({ id: entry.id, text: entry.text, category: entry.category, source: entry.source });
    if (out.length >= limit) return out;
  }

  return out;
}
