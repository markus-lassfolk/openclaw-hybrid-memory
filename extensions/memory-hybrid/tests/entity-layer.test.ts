/**
 * Organizations, contacts, and fact_entity_mentions (#985–#987).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FactsDB } from "../backends/facts-db.js";
import { normalizeEntityKey } from "../backends/facts-db/entity-layer.js";
import { detectFactTextLanguage } from "../services/entity-enrichment.js";

describe("normalizeEntityKey", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeEntityKey("  Acme   Corp  ")).toBe("acme corp");
  });
});

describe("detectFactTextLanguage (franc)", () => {
  it("detects a Swedish-heavy sample (ISO 639-3)", () => {
    const t = "Mötet med Företag AB och Anna Svensson handlade om budgeten för nästa kvartal och leveransdatum.";
    const lang = detectFactTextLanguage(t);
    expect(lang).toBe("swe");
  });
});

describe("FactsDB entity layer persistence", () => {
  let dir: string;
  let db: FactsDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hybrid-entity-"));
    mkdirSync(dir, { recursive: true });
    db = new FactsDB(join(dir, "facts.db"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applyEntityEnrichment links ORG facts and sets contact primary org when co-mentioned", () => {
    const fact = db.store({
      text: "Anna Svensson from Acme Corporation confirmed the API deadline for the integration project.",
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
          label: "ORG",
          surfaceText: "Acme Corporation",
          normalizedSurface: "acme corporation",
          startOffset: 22,
          endOffset: 38,
          confidence: 0.9,
        },
        {
          label: "PERSON",
          surfaceText: "Anna Svensson",
          normalizedSurface: "anna svensson",
          startOffset: 0,
          endOffset: 13,
          confidence: 0.85,
        },
      ],
      "eng",
    );

    const org = db.lookupOrganization("acme corporation");
    expect(org).not.toBeNull();
    expect(db.listFactIdsLinkedToOrg(org!.id, 10)).toContain(fact.id);

    const people = db.listContactsForOrganization(org!.id, 10);
    expect(people.some((p) => p.displayName.toLowerCase().includes("anna"))).toBe(true);
  });
});
