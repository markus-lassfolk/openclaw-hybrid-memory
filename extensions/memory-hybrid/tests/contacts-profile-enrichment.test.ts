/**
 * Structured contact profile enrichment: NER -> contacts merge (issue #2014).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";

describe("contact profile enrichment and merge (#2014)", () => {
  let dir: string;
  let db: FactsDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hybrid-contacts-"));
    mkdirSync(dir, { recursive: true });
    db = new FactsDB(join(dir, "facts.db"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function storeAndTagPerson(text: string, surface: string, offset: number) {
    const fact = db.store({
      text,
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    db.applyEntityEnrichment(
      fact.id,
      [
        {
          label: "PERSON",
          surfaceText: surface,
          normalizedSurface: surface.toLowerCase(),
          startOffset: offset,
          endOffset: offset + surface.length,
          confidence: 0.9,
        },
      ],
      "eng",
    );
    return fact;
  }

  it("acceptance criterion: storing the Daniel Thunberg example updates contacts.email and role", () => {
    const text = "Daniel Thunberg email daniel.thunberg@avoki.com Sverigechef Avoki";
    const fact = storeAndTagPerson(text, "Daniel Thunberg", 0);

    const result = db.applyContactProfileEnrichment(fact.id, text, "ner");
    expect(result).not.toBeNull();

    const contacts = db.listContactsByNamePrefix("Daniel", 10);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].email).toBe("daniel.thunberg@avoki.com");
    expect(contacts[0].role).toBe("Sverigechef Avoki");
    expect(contacts[0].boardStatus).toBe("management");
  });

  it("does not attribute either address when a single-person mention's text contains 2+ distinct emails (#2062)", () => {
    const text = "Daniel Thunberg, cc: ops@other-example.com — daniel.thunberg@avoki.com, Sverigechef Avoki";
    const fact = storeAndTagPerson(text, "Daniel Thunberg", 0);

    const result = db.applyContactProfileEnrichment(fact.id, text, "ner");
    expect(result).not.toBeNull();

    const contacts = db.listContactsByNamePrefix("Daniel", 10);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].email).toBeNull();
  });

  it("does not enrich when a fact mentions more than one person (ambiguous attribution)", () => {
    const fact = db.store({
      text: "Alice alice@example.com and Bob bob@example.com discussed the roadmap.",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    db.applyEntityEnrichment(
      fact.id,
      [
        { label: "PERSON", surfaceText: "Alice", normalizedSurface: "alice", startOffset: 0, endOffset: 5, confidence: 0.9 },
        { label: "PERSON", surfaceText: "Bob", normalizedSurface: "bob", startOffset: 29, endOffset: 32, confidence: 0.9 },
      ],
      "eng",
    );
    const result = db.applyContactProfileEnrichment(fact.id, fact.text, "ner");
    expect(result).toBeNull();
    expect(db.listContactsByNamePrefix("Alice", 10)[0]?.email).toBeNull();
  });

  it("does not let a lower-priority ner update clobber a higher-priority manual value", () => {
    const first = storeAndTagPerson("Contact Carla carla@old-domain.com", "Carla", 8);
    db.applyContactProfileEnrichment(first.id, first.text, "ner");
    let carla = db.listContactsByNamePrefix("Carla", 10)[0];
    expect(carla.email).toBe("carla@old-domain.com");

    // Simulate an explicit manual correction (highest priority).
    db.upsertContactWithProfile("Carla", carla.primaryOrgId, {
      email: "carla@correct-domain.com",
      updatedBy: "manual",
      source: "manual",
    });
    carla = db.listContactsByNamePrefix("Carla", 10)[0];
    expect(carla.email).toBe("carla@correct-domain.com");

    // A subsequent NER-sourced fact with a different email must NOT overwrite the manual value.
    const second = storeAndTagPerson("Carla carla@stale-scrape.com", "Carla", 0);
    db.applyContactProfileEnrichment(second.id, second.text, "ner");
    carla = db.listContactsByNamePrefix("Carla", 10)[0];
    expect(carla.email).toBe("carla@correct-domain.com");
  });

  it("auto-merges an unambiguous single-token duplicate into the existing full-name contact", () => {
    storeAndTagPerson("Daniel Thunberg joined the call.", "Daniel Thunberg", 0);
    storeAndTagPerson("Daniel confirmed the deadline.", "Daniel", 0);

    const contacts = db.listContactsByNamePrefix("Daniel", 10);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].displayName).toBe("Daniel Thunberg");
    const aliases = JSON.parse(contacts[0].aliasesJson ?? "[]");
    expect(aliases).toContain("Daniel");
  });

  it("does not auto-merge when there are multiple ambiguous candidates", () => {
    storeAndTagPerson("Daniel Thunberg joined the call.", "Daniel Thunberg", 0);
    storeAndTagPerson("Daniel Andersson joined too.", "Daniel Andersson", 0);
    storeAndTagPerson("Daniel confirmed the deadline.", "Daniel", 0);

    const contacts = db.listContactsByNamePrefix("Daniel", 10);
    // Two full-name contacts remain distinct, plus "Daniel" itself since 2 candidates = ambiguous.
    expect(contacts.map((c) => c.displayName).sort()).toEqual(["Daniel", "Daniel Andersson", "Daniel Thunberg"]);
  });

  it("requireSurnameForNewContacts skips creating a contact for a lone single-token PERSON mention", () => {
    const fact = db.store({
      text: "Erik said the deploy went fine.",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    db.applyEntityEnrichment(
      fact.id,
      [{ label: "PERSON", surfaceText: "Erik", normalizedSurface: "erik", startOffset: 0, endOffset: 4, confidence: 0.9 }],
      "eng",
      { requireSurnameForNewContacts: true },
    );
    expect(db.listContactsByNamePrefix("Erik", 10)).toHaveLength(0);
  });

  it("requireSurnameForNewContacts still allows creation when the fact also mentions an org", () => {
    const fact = db.store({
      text: "Erik from Acme Corp confirmed the deploy.",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    db.applyEntityEnrichment(
      fact.id,
      [
        { label: "PERSON", surfaceText: "Erik", normalizedSurface: "erik", startOffset: 0, endOffset: 4, confidence: 0.9 },
        { label: "ORG", surfaceText: "Acme Corp", normalizedSurface: "acme corp", startOffset: 10, endOffset: 19, confidence: 0.9 },
      ],
      "eng",
      { requireSurnameForNewContacts: true },
    );
    expect(db.listContactsByNamePrefix("Erik", 10)).toHaveLength(1);
  });

  it("mergeContacts repoints mentions, folds in profile fields, and deletes the source contact", () => {
    const a = storeAndTagPerson("Contact Alpha alpha@example.com", "Alpha", 8);
    const b = storeAndTagPerson("Beta discussed the launch.", "Beta", 0);
    db.applyContactProfileEnrichment(a.id, a.text, "ner");

    const alphaContact = db.listContactsByNamePrefix("Alpha", 10)[0];
    const betaContact = db.listContactsByNamePrefix("Beta", 10)[0];
    expect(alphaContact.email).toBe("alpha@example.com");
    expect(betaContact.email).toBeNull();

    const result = db.mergeContacts(alphaContact.id, betaContact.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.mergedFactMentions).toBeGreaterThanOrEqual(1);

    const remaining = db.listContactsByNamePrefix("", 20).filter((c) => c.id === alphaContact.id || c.id === betaContact.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(betaContact.id);
    expect(remaining[0].email).toBe("alpha@example.com");
    const aliases = JSON.parse(remaining[0].aliasesJson ?? "[]");
    expect(aliases).toContain("Alpha");

    expect(db.getContactById(alphaContact.id)).toBeNull();
  });

  it("mergeContacts rejects merging a contact into itself", () => {
    storeAndTagPerson("Gamma said hi.", "Gamma", 0);
    const gamma = db.listContactsByNamePrefix("Gamma", 10)[0];
    const result = db.mergeContacts(gamma.id, gamma.id);
    expect(result.ok).toBe(false);
  });

  it("suggest-merge candidates: findContactMergeCandidates finds token prefix/suffix matches", () => {
    storeAndTagPerson("Daniel Thunberg joined.", "Daniel Thunberg", 0);
    const target = db.listContactsByNamePrefix("Daniel", 10)[0];
    // "thunberg" is a token suffix of "daniel thunberg" — should surface as a merge candidate.
    const candidates = db.findContactMergeCandidates("thunberg");
    expect(candidates.map((c) => c.id)).toContain(target.id);
  });
});
