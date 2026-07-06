/**
 * Resolve vault-facts SPO triples from entity layer (Issue #1912).
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { ScopeFilter } from "../types/memory.js";
import { matchEntitiesInPrompt, type SpoTriple } from "./vault-context.js";

type OrgRow = { id: string; display_name: string };
type ContactRow = { id: string; display_name: string; primary_org_id: string | null };

function loadOrgRows(db: ReturnType<FactsDB["getRawDb"]>): OrgRow[] {
  try {
    return db.prepare(`SELECT id, display_name FROM organizations ORDER BY display_name LIMIT 200`).all() as OrgRow[];
  } catch {
    return [];
  }
}

function loadContactRows(db: ReturnType<FactsDB["getRawDb"]>): ContactRow[] {
  try {
    return db
      .prepare(`SELECT id, display_name, primary_org_id FROM contacts ORDER BY display_name LIMIT 200`)
      .all() as ContactRow[];
  } catch {
    return [];
  }
}

/** Build SPO triples for entities mentioned in the user prompt. */
export function resolveVaultFactsTriples(
  factsDb: FactsDB,
  prompt: string,
  maxTriples = 20,
  scopeFilter?: ScopeFilter | null,
): SpoTriple[] {
  const db = factsDb.getRawDb();
  const orgRows = loadOrgRows(db);
  const contactRows = loadContactRows(db);
  if (orgRows.length === 0 && contactRows.length === 0) return [];

  const knownEntities = [...orgRows.map((o) => o.display_name), ...contactRows.map((c) => c.display_name)];
  const matched = matchEntitiesInPrompt(prompt, knownEntities);
  if (matched.length === 0) return [];

  const triples: SpoTriple[] = [];
  const orgByName = new Map(orgRows.map((o) => [o.display_name.toLowerCase(), o]));
  const contactByName = new Map(contactRows.map((c) => [c.display_name.toLowerCase(), c]));

  for (const entity of matched) {
    const key = entity.toLowerCase();
    const contact = contactByName.get(key);
    if (contact?.primary_org_id) {
      const org = orgRows.find((o) => o.id === contact.primary_org_id);
      if (org) {
        triples.push({ subject: contact.display_name, predicate: "works_at", object: org.display_name });
      }
    }
    const org = orgByName.get(key);
    if (org) {
      const factIds = factsDb.listFactIdsLinkedToOrg(org.id, 3);
      for (const factId of factIds) {
        // SECURITY: org/contact rows aren't scoped themselves, but the facts linked to them
        // are — scope-check each one (same pattern as register-directory-tools.ts) so a fact
        // linked to an org by one tenant can't leak into another tenant's injected context.
        const fact = factsDb.getById(factId, { scopeFilter });
        if (!fact?.key || !fact.value) continue;
        triples.push({
          subject: org.display_name,
          predicate: fact.key,
          object: String(fact.value).slice(0, 120),
        });
        if (triples.length >= maxTriples) return sortTriples(triples);
      }
    }
  }

  return sortTriples(triples).slice(0, maxTriples);
}

/** Merge SPO triples from multiple vault facts DBs (multi-vault fan-out). */
export function resolveVaultFactsTriplesMulti(
  factsDbs: FactsDB[],
  prompt: string,
  maxTriples = 20,
  scopeFilter?: ScopeFilter | null,
): SpoTriple[] {
  if (factsDbs.length === 0) return [];
  const seen = new Set<string>();
  const merged: SpoTriple[] = [];
  for (const factsDb of factsDbs) {
    for (const triple of resolveVaultFactsTriples(factsDb, prompt, maxTriples, scopeFilter)) {
      const key = `${triple.subject}|${triple.predicate}|${triple.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(triple);
      if (merged.length >= maxTriples) return sortTriples(merged);
    }
  }
  return sortTriples(merged).slice(0, maxTriples);
}

function sortTriples(triples: SpoTriple[]): SpoTriple[] {
  return [...triples].sort((a, b) => {
    const sub = a.subject.localeCompare(b.subject);
    if (sub !== 0) return sub;
    return a.predicate.localeCompare(b.predicate);
  });
}
