/**
 * Entity-layer lookups for ambient and constrained retrieval (#1802).
 */

import type { DatabaseSync } from "node:sqlite";
import { normalizeEntityKey } from "../backends/facts-db/entity-layer.js";
import { escapeLikeLiteralForBackslashEscape } from "../backends/facts-db/entity-layer.js";

export type KnownEntitySurface = {
  key: string;
  displayName: string;
  label: "PERSON" | "ORG" | "PROJECT" | "OTHER";
  contactId?: string;
  organizationId?: string;
};

/**
 * Load known entity surfaces from contacts, organizations, and NER mentions.
 */
export function loadKnownEntitySurfaces(db: DatabaseSync, limit = 500): KnownEntitySurface[] {
  const surfaces: KnownEntitySurface[] = [];
  const seen = new Set<string>();

  const contacts = db
    .prepare(
      `SELECT id, display_name, normalized_key, aliases_json FROM contacts ORDER BY display_name LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; display_name: string; normalized_key: string; aliases_json: string | null }>;

  for (const c of contacts) {
    const key = c.normalized_key || normalizeEntityKey(c.display_name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    surfaces.push({ key, displayName: c.display_name, label: "PERSON", contactId: c.id });
    if (c.aliases_json) {
      try {
        const aliases = JSON.parse(c.aliases_json) as string[];
        for (const alias of aliases) {
          const aliasKey = normalizeEntityKey(alias);
          if (aliasKey && !seen.has(aliasKey)) {
            seen.add(aliasKey);
            surfaces.push({ key: aliasKey, displayName: alias, label: "PERSON", contactId: c.id });
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  const orgs = db
    .prepare(`SELECT id, display_name, canonical_key, aliases_json FROM organizations ORDER BY display_name LIMIT ?`)
    .all(limit) as Array<{ id: string; display_name: string; canonical_key: string; aliases_json: string | null }>;

  for (const o of orgs) {
    const key = o.canonical_key || normalizeEntityKey(o.display_name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    surfaces.push({ key, displayName: o.display_name, label: "ORG", organizationId: o.id });
  }

  const mentionRows = db
    .prepare(
      `SELECT DISTINCT normalized_surface, label, contact_id, organization_id
         FROM fact_entity_mentions
         WHERE normalized_surface IS NOT NULL AND length(normalized_surface) >= 2
         ORDER BY normalized_surface
         LIMIT ?`,
    )
    .all(limit) as Array<{
    normalized_surface: string;
    label: string;
    contact_id: string | null;
    organization_id: string | null;
  }>;

  for (const row of mentionRows) {
    const key = row.normalized_surface.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const label =
      row.label === "PERSON"
        ? "PERSON"
        : row.label === "ORG"
          ? "ORG"
          : row.label === "PROJECT"
            ? "PROJECT"
            : "OTHER";
    surfaces.push({
      key,
      displayName: row.normalized_surface,
      label,
      contactId: row.contact_id ?? undefined,
      organizationId: row.organization_id ?? undefined,
    });
  }

  return surfaces;
}

/**
 * Match entity surfaces mentioned in message text.
 */
export function matchEntitySurfacesInText(text: string, surfaces: KnownEntitySurface[]): KnownEntitySurface[] {
  const lower = text.toLowerCase();
  const matched: KnownEntitySurface[] = [];
  const seen = new Set<string>();

  for (const surface of surfaces) {
    if (seen.has(surface.key)) continue;
    const escaped = surface.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(lower) || lower.includes(surface.key)) {
      seen.add(surface.key);
      matched.push(surface);
    }
  }

  return matched.slice(0, 10);
}

/**
 * Resolve fact IDs linked to matched entity surfaces via mentions and entity field.
 */
export function getFactIdsForEntitySurfaces(db: DatabaseSync, surfaces: KnownEntitySurface[], limit = 50): string[] {
  if (surfaces.length === 0) return [];
  const ids = new Set<string>();
  const nowSec = Math.floor(Date.now() / 1000);

  for (const surface of surfaces) {
    if (ids.size >= limit) break;

    const mentionRows = db
      .prepare(
        `SELECT DISTINCT fact_id FROM fact_entity_mentions
           WHERE normalized_surface = ? OR contact_id = ? OR organization_id = ?
           LIMIT ?`,
      )
      .all(
        surface.key,
        surface.contactId ?? null,
        surface.organizationId ?? null,
        Math.min(20, limit - ids.size),
      ) as Array<{ fact_id: string }>;

    for (const row of mentionRows) ids.add(row.fact_id);

    const escaped = escapeLikeLiteralForBackslashEscape(surface.displayName);
    const entityRows = db
      .prepare(
        `SELECT id FROM facts
           WHERE superseded_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
             AND lower(entity) = lower(?)
           LIMIT ?`,
      )
      .all(nowSec, surface.displayName, Math.min(10, limit - ids.size)) as Array<{ id: string }>;

    for (const row of entityRows) ids.add(row.id);
  }

  return [...ids].slice(0, limit);
}
