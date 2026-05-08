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

  if (merged.sourceFactIds.length === 0) delete merged.sourceFactIds;
  if (merged.sourceEventIds.length === 0) delete merged.sourceEventIds;
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
