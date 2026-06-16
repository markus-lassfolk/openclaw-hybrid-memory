/**
 * Resolve vault-facts SPO triples from entity layer (Issue #1912).
 */

import type { FactsDB } from "../backends/facts-db.js";
import { matchEntitiesInPrompt, type SpoTriple } from "./vault-context.js";

/** Build SPO triples for entities mentioned in the user prompt. */
export function resolveVaultFactsTriples(
  factsDb: FactsDB,
  prompt: string,
  maxTriples = 20,
): SpoTriple[] {
  const db = factsDb.getRawDb();
  const orgRows = db
    .prepare(`SELECT id, name FROM organizations ORDER BY name LIMIT 200`)
    .all() as Array<{ id: string; name: string }>;
  const contactRows = db
    .prepare(`SELECT id, name, primary_org_id FROM contacts ORDER BY name LIMIT 200`)
    .all() as Array<{ id: string; name: string; primary_org_id: string | null }>;

  const knownEntities = [
    ...orgRows.map((o) => o.name),
    ...contactRows.map((c) => c.name),
  ];
  const matched = matchEntitiesInPrompt(prompt, knownEntities);
  if (matched.length === 0) return [];

  const triples: SpoTriple[] = [];
  const orgByName = new Map(orgRows.map((o) => [o.name.toLowerCase(), o]));
  const contactByName = new Map(contactRows.map((c) => [c.name.toLowerCase(), c]));

  for (const entity of matched) {
    const key = entity.toLowerCase();
    const contact = contactByName.get(key);
    if (contact?.primary_org_id) {
      const org = orgRows.find((o) => o.id === contact.primary_org_id);
      if (org) {
        triples.push({ subject: contact.name, predicate: "works_at", object: org.name });
      }
    }
    const org = orgByName.get(key);
    if (org) {
      const factIds = factsDb.listFactIdsLinkedToOrg(org.id, 3);
      for (const factId of factIds) {
        const fact = factsDb.getById(factId);
        if (!fact?.key || !fact.value) continue;
        triples.push({
          subject: org.name,
          predicate: fact.key,
          object: String(fact.value).slice(0, 120),
        });
        if (triples.length >= maxTriples) return sortTriples(triples);
      }
    }
  }

  return sortTriples(triples).slice(0, maxTriples);
}

function sortTriples(triples: SpoTriple[]): SpoTriple[] {
  return [...triples].sort((a, b) => {
    const sub = a.subject.localeCompare(b.subject);
    if (sub !== 0) return sub;
    return a.predicate.localeCompare(b.predicate);
  });
}
