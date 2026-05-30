/**
 * Organizations, contacts, and fact_entity_mentions (#985–#987).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import {
  escapeLikeLiteralForBackslashEscape,
  normalizeEntityKey,
  normalizeFactEntityMentionsForPersistence,
} from "../backends/facts-db/entity-layer.js";
import { detectFactTextLanguage, isEntityStopWord } from "../services/entity-enrichment.js";

describe("normalizeEntityKey", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeEntityKey("  Acme   Corp  ")).toBe("acme corp");
  });
});

describe("escapeLikeLiteralForBackslashEscape", () => {
  it("escapes LIKE wildcards and backslashes for ESCAPE '\\'", () => {
    expect(escapeLikeLiteralForBackslashEscape("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });
});

describe("normalizeFactEntityMentionsForPersistence", () => {
  it("normalizes, filters, and deduplicates noisy mentions before persistence", () => {
    expect(
      normalizeFactEntityMentionsForPersistence([
        {
          label: "ORG",
          surfaceText: "  Hybrid-memory   PR Pipeline  ",
          normalizedSurface: "Hybrid-memory   PR Pipeline",
          startOffset: 0,
          endOffset: 28,
          confidence: 0.6,
        },
        {
          label: "ORG",
          surfaceText: "hybrid-memory pr pipeline",
          normalizedSurface: "hybrid-memory pr pipeline",
          startOffset: 0,
          endOffset: 26,
          confidence: 0.9,
        },
        {
          label: "ORG",
          surfaceText: "whatsapp",
          normalizedSurface: "whatsapp",
          startOffset: 40,
          endOffset: 48,
          confidence: 0.8,
        },
        {
          label: "PERSON",
          surfaceText: "Surgeon",
          normalizedSurface: "surgeon",
          startOffset: 60,
          endOffset: 67,
          confidence: 0.8,
        },
        {
          label: "ORG",
          surfaceText: "Acme",
          normalizedSurface: "acme",
          startOffset: 80,
          endOffset: 84,
          confidence: 0.9,
        },
        {
          label: "ORG",
          surfaceText: "Acme Corporation",
          normalizedSurface: "acme corporation",
          startOffset: 80,
          endOffset: 96,
          confidence: 0.95,
        },
        {
          label: "ORG",
          surfaceText: "AI",
          normalizedSurface: "ai",
          startOffset: 100,
          endOffset: 102,
          confidence: 0.9,
        },
      ]),
    ).toEqual([
      {
        label: "ORG",
        surfaceText: "hybrid-memory pr pipeline",
        normalizedSurface: "hybrid-memory pr pipeline",
        startOffset: 0,
        endOffset: 26,
        confidence: 0.9,
      },
      {
        label: "ORG",
        surfaceText: "Acme Corporation",
        normalizedSurface: "acme corporation",
        startOffset: 80,
        endOffset: 96,
        confidence: 0.95,
      },
    ]);
  });

  it("preserves distinct entities that are coincidental character-level substrings", () => {
    expect(
      normalizeFactEntityMentionsForPersistence([
        {
          label: "ORG",
          surfaceText: "Ford",
          normalizedSurface: "ford",
          startOffset: 0,
          endOffset: 4,
          confidence: 0.9,
        },
        {
          label: "ORG",
          surfaceText: "Oxford",
          normalizedSurface: "oxford",
          startOffset: 10,
          endOffset: 16,
          confidence: 0.9,
        },
        {
          label: "PERSON",
          surfaceText: "Rich",
          normalizedSurface: "rich",
          startOffset: 20,
          endOffset: 24,
          confidence: 0.9,
        },
        {
          label: "PERSON",
          surfaceText: "Richard",
          normalizedSurface: "richard",
          startOffset: 30,
          endOffset: 37,
          confidence: 0.9,
        },
        {
          label: "PERSON",
          surfaceText: "Art",
          normalizedSurface: "art",
          startOffset: 40,
          endOffset: 43,
          confidence: 0.9,
        },
        {
          label: "PERSON",
          surfaceText: "Martin",
          normalizedSurface: "martin",
          startOffset: 50,
          endOffset: 56,
          confidence: 0.9,
        },
        {
          label: "ORG",
          surfaceText: "Ace",
          normalizedSurface: "ace",
          startOffset: 60,
          endOffset: 63,
          confidence: 0.9,
        },
        {
          label: "ORG",
          surfaceText: "Space",
          normalizedSurface: "space",
          startOffset: 70,
          endOffset: 75,
          confidence: 0.9,
        },
      ]),
    ).toEqual([
      {
        label: "ORG",
        surfaceText: "Ford",
        normalizedSurface: "ford",
        startOffset: 0,
        endOffset: 4,
        confidence: 0.9,
      },
      {
        label: "ORG",
        surfaceText: "Oxford",
        normalizedSurface: "oxford",
        startOffset: 10,
        endOffset: 16,
        confidence: 0.9,
      },
      {
        label: "PERSON",
        surfaceText: "Rich",
        normalizedSurface: "rich",
        startOffset: 20,
        endOffset: 24,
        confidence: 0.9,
      },
      {
        label: "PERSON",
        surfaceText: "Richard",
        normalizedSurface: "richard",
        startOffset: 30,
        endOffset: 37,
        confidence: 0.9,
      },
      {
        label: "PERSON",
        surfaceText: "Art",
        normalizedSurface: "art",
        startOffset: 40,
        endOffset: 43,
        confidence: 0.9,
      },
      {
        label: "PERSON",
        surfaceText: "Martin",
        normalizedSurface: "martin",
        startOffset: 50,
        endOffset: 56,
        confidence: 0.9,
      },
      {
        label: "ORG",
        surfaceText: "Ace",
        normalizedSurface: "ace",
        startOffset: 60,
        endOffset: 63,
        confidence: 0.9,
      },
      {
        label: "ORG",
        surfaceText: "Space",
        normalizedSurface: "space",
        startOffset: 70,
        endOffset: 75,
        confidence: 0.9,
      },
    ]);
  });
});

describe("entity enrichment stop words", () => {
  it("filters generic common-noun pseudo-entities", () => {
    expect(isEntityStopWord("User")).toBe(true);
    expect(isEntityStopWord("Credentials")).toBe(true);
    expect(isEntityStopWord("convention")).toBe(true);
    expect(isEntityStopWord("Home Assistant")).toBe(false);
    expect(isEntityStopWord("Acme Corporation")).toBe(false);
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
  let dbPath: string;
  let db: FactsDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hybrid-entity-"));
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "facts.db");
    db = new FactsDB(dbPath);
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
    if (!org) throw new Error("expected org");
    expect(db.listFactIdsLinkedToOrg(org.id, 10)).toContain(fact.id);

    const people = db.listContactsForOrganization(org.id, 10);
    expect(people.some((p) => p.displayName.toLowerCase().includes("anna"))).toBe(true);
  });

  it("marks facts as enriched even when the LLM returns zero mentions (queue drains)", () => {
    const fact = db.store({
      text: "Short text that is still long enough for min length checks in other code paths.",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    expect(db.listFactIdsNeedingEntityEnrichment(50, 10)).toContain(fact.id);
    db.applyEntityEnrichment(fact.id, [], "und");
    expect(db.listFactIdsNeedingEntityEnrichment(50, 10)).not.toContain(fact.id);
  });

  it("listContactsByNamePrefix treats % in prefix as literal when ESCAPE is used", () => {
    const fact = db.store({
      text: "Contact note about 100% Pure brand and nothing else matters here for length.",
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
          surfaceText: "100% Pure",
          normalizedSurface: "100% pure",
          startOffset: 0,
          endOffset: 9,
          confidence: 0.9,
        },
      ],
      "eng",
    );
    const byPrefix = db.listContactsByNamePrefix("100%", 10);
    expect(byPrefix.some((c) => c.displayName.includes("100%"))).toBe(true);
  });

  it("deduplicates persisted mentions after normalization and skips generic noise", () => {
    const fact = db.store({
      text: "Hybrid-memory PR Pipeline mentioned Hybrid-memory PR Pipeline while Acme Corporation replaced Acme and Surgeon reviewed whatsapp logs.",
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
          surfaceText: " Hybrid-memory   PR Pipeline ",
          normalizedSurface: "Hybrid-memory   PR Pipeline",
          startOffset: 0,
          endOffset: 28,
          confidence: 0.7,
        },
        {
          label: "ORG",
          surfaceText: "hybrid-memory pr pipeline",
          normalizedSurface: "hybrid-memory pr pipeline",
          startOffset: 36,
          endOffset: 62,
          confidence: 0.92,
        },
        {
          label: "ORG",
          surfaceText: "Acme",
          normalizedSurface: "acme",
          startOffset: 94,
          endOffset: 98,
          confidence: 0.9,
        },
        {
          label: "ORG",
          surfaceText: "Acme Corporation",
          normalizedSurface: "Acme   Corporation",
          startOffset: 77,
          endOffset: 93,
          confidence: 0.95,
        },
        {
          label: "PERSON",
          surfaceText: "Surgeon",
          normalizedSurface: "surgeon",
          startOffset: 103,
          endOffset: 110,
          confidence: 0.8,
        },
        {
          label: "ORG",
          surfaceText: "whatsapp",
          normalizedSurface: "whatsapp",
          startOffset: 120,
          endOffset: 128,
          confidence: 0.8,
        },
      ],
      "eng",
    );

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const mentions = raw
        .prepare(
          "SELECT label, surface_text, normalized_surface FROM fact_entity_mentions WHERE fact_id = ? ORDER BY normalized_surface",
        )
        .all(fact.id) as Array<{ label: string; surface_text: string; normalized_surface: string }>;
      expect(mentions).toEqual([
        {
          label: "ORG",
          surface_text: "Acme Corporation",
          normalized_surface: "acme corporation",
        },
        {
          label: "ORG",
          surface_text: "hybrid-memory pr pipeline",
          normalized_surface: "hybrid-memory pr pipeline",
        },
      ]);

      const orgNames = raw.prepare("SELECT display_name FROM organizations ORDER BY canonical_key").all() as Array<{
        display_name: string;
      }>;
      expect(orgNames).toEqual([{ display_name: "Acme Corporation" }, { display_name: "hybrid-memory pr pipeline" }]);

      const contactCount = raw.prepare("SELECT COUNT(*) AS count FROM contacts").get() as { count: number };
      expect(contactCount.count).toBe(0);
    } finally {
      raw.close();
    }
  });
});
