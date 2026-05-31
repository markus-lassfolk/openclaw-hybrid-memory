/**
 * Organizations, contacts, and fact_entity_mentions (#985–#987).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import {
  escapeLikeLiteralForBackslashEscape,
  normalizeEntityKey,
  normalizeFactEntityMentionsForPersistence,
} from "../backends/facts-db/entity-layer.js";
import {
  detectFactTextLanguage,
  extractEntityMentionsWithLlm,
  isEntityStopWord,
} from "../services/entity-enrichment.js";

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
          surfaceText: "A",
          normalizedSurface: "a",
          startOffset: 100,
          endOffset: 101,
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

  it("preserves extractor-provided canonical normalized surfaces", () => {
    const result = normalizeFactEntityMentionsForPersistence([
      {
        label: "ORG",
        surfaceText: "OpenAI",
        normalizedSurface: "OpenAI",
        startOffset: 0,
        endOffset: 6,
        confidence: 0.8,
      },
      {
        label: "ORG",
        surfaceText: "OpenAI, Inc.",
        normalizedSurface: "OpenAI",
        startOffset: 0,
        endOffset: 12,
        confidence: 0.9,
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((mention) => mention.normalizedSurface)).toEqual(["openai", "openai"]);
    expect(result.map((mention) => mention.surfaceText)).toEqual(["OpenAI", "OpenAI, Inc."]);
  });

  it("keeps valid two-character entity mentions", () => {
    expect(
      normalizeFactEntityMentionsForPersistence([
        {
          label: "PERSON",
          surfaceText: "Li",
          normalizedSurface: "li",
          startOffset: 0,
          endOffset: 2,
          confidence: 0.9,
        },
        {
          label: "PERSON",
          surfaceText: "Xi",
          normalizedSurface: "xi",
          startOffset: 3,
          endOffset: 5,
          confidence: 0.9,
        },
        {
          label: "ORG",
          surfaceText: "HP",
          normalizedSurface: "hp",
          startOffset: 6,
          endOffset: 8,
          confidence: 0.9,
        },
        {
          label: "ORG",
          surfaceText: "3M",
          normalizedSurface: "3m",
          startOffset: 9,
          endOffset: 11,
          confidence: 0.9,
        },
        {
          label: "ORG",
          surfaceText: "小米",
          normalizedSurface: "小米",
          startOffset: 12,
          endOffset: 14,
          confidence: 0.9,
        },
        {
          label: "ORG",
          surfaceText: "腾讯",
          normalizedSurface: "腾讯",
          startOffset: 15,
          endOffset: 17,
          confidence: 0.9,
        },
        {
          label: "ORG",
          surfaceText: "ab",
          normalizedSurface: "ab",
          startOffset: 18,
          endOffset: 20,
          confidence: 0.9,
        },
      ]),
    ).toEqual([
      {
        label: "PERSON",
        surfaceText: "Li",
        normalizedSurface: "li",
        startOffset: 0,
        endOffset: 2,
        confidence: 0.9,
      },
      {
        label: "PERSON",
        surfaceText: "Xi",
        normalizedSurface: "xi",
        startOffset: 3,
        endOffset: 5,
        confidence: 0.9,
      },
      {
        label: "ORG",
        surfaceText: "HP",
        normalizedSurface: "hp",
        startOffset: 6,
        endOffset: 8,
        confidence: 0.9,
      },
      {
        label: "ORG",
        surfaceText: "3M",
        normalizedSurface: "3m",
        startOffset: 9,
        endOffset: 11,
        confidence: 0.9,
      },
      {
        label: "ORG",
        surfaceText: "小米",
        normalizedSurface: "小米",
        startOffset: 12,
        endOffset: 14,
        confidence: 0.9,
      },
      {
        label: "ORG",
        surfaceText: "腾讯",
        normalizedSurface: "腾讯",
        startOffset: 15,
        endOffset: 17,
        confidence: 0.9,
      },
    ]);
  });

  it("does not drop non-overlapping mentions that share a token", () => {
    expect(
      normalizeFactEntityMentionsForPersistence([
        {
          label: "PERSON",
          surfaceText: "Lee",
          normalizedSurface: "lee",
          startOffset: 0,
          endOffset: 3,
          confidence: 0.9,
        },
        {
          label: "PERSON",
          surfaceText: "Lee Chang",
          normalizedSurface: "lee chang",
          startOffset: 20,
          endOffset: 29,
          confidence: 0.9,
        },
      ]),
    ).toEqual([
      {
        label: "PERSON",
        surfaceText: "Lee",
        normalizedSurface: "lee",
        startOffset: 0,
        endOffset: 3,
        confidence: 0.9,
      },
      {
        label: "PERSON",
        surfaceText: "Lee Chang",
        normalizedSurface: "lee chang",
        startOffset: 20,
        endOffset: 29,
        confidence: 0.9,
      },
    ]);
  });

  it("treats punctuation as a boundary when pruning overlapping contained mentions", () => {
    expect(
      normalizeFactEntityMentionsForPersistence([
        {
          label: "ORG",
          surfaceText: "Acme",
          normalizedSurface: "acme",
          startOffset: 0,
          endOffset: 4,
          confidence: 0.9,
        },
        {
          label: "ORG",
          surfaceText: "Acme, Inc.",
          normalizedSurface: "acme, inc.",
          startOffset: 0,
          endOffset: 10,
          confidence: 0.95,
        },
      ]),
    ).toEqual([
      {
        label: "ORG",
        surfaceText: "Acme, Inc.",
        normalizedSurface: "acme, inc.",
        startOffset: 0,
        endOffset: 10,
        confidence: 0.95,
      },
    ]);
  });

  it("keeps offsets aligned with trimmed surface text", () => {
    expect(
      normalizeFactEntityMentionsForPersistence([
        {
          label: "ORG",
          surfaceText: "  OpenAI  ",
          normalizedSurface: "openai",
          startOffset: 10,
          endOffset: 20,
          confidence: 0.9,
        },
      ]),
    ).toEqual([
      {
        label: "ORG",
        surfaceText: "OpenAI",
        normalizedSurface: "openai",
        startOffset: 12,
        endOffset: 18,
        confidence: 0.9,
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

describe("extractEntityMentionsWithLlm", () => {
  it("stores canonicalized surface text from quality gate output", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content:
                    '{"mentions":[{"label":"ORG","text":"Home   Assistant","start":0,"end":16,"confidence":0.9}]}',
                },
              },
            ],
          }),
        },
      },
    };

    const result = await extractEntityMentionsWithLlm(
      "Home   Assistant helps with automations and reminders.",
      openai as never,
      "gpt-5-mini",
    );

    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0]).toMatchObject({
      label: "SERVICE",
      surfaceText: "Home   Assistant",
      normalizedSurface: "home assistant",
    });
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

  it("prioritizes pending enrichment by tier, access, recall/access count, importance, and created_at", () => {
    const hotHighAccess = db.store({
      text: "hot fact with higher access score and enough length for enrichment ordering checks",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.2,
      source: "test",
    });
    const hotHighImportance = db.store({
      text: "hot fact with lower access score but higher importance and enough length for ordering checks",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.9,
      source: "test",
    });
    const hotOlderAccess = db.store({
      text: "hot fact with older last_accessed should sort after newer hot facts in enrichment queue",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.95,
      source: "test",
    });
    const warmRecent = db.store({
      text: "warm fact with very recent access should still trail all hot facts for tier priority",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.8,
      source: "test",
    });
    const structuralRecent = db.store({
      text: "structural fact for ordering checks with recent access metadata and enough body length",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.7,
      source: "test",
    });
    const coldRecent = db.store({
      text: "cold fact used to verify tier priority remains below structural regardless of recency",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.99,
      source: "test",
    });
    const unknownTier = db.store({
      text: "custom tier fact should fall into unknown bucket and sort after known tiers",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });

    db.setTier(hotHighAccess.id, "hot");
    db.setTier(hotHighImportance.id, "hot");
    db.setTier(hotOlderAccess.id, "hot");
    db.setTier(warmRecent.id, "warm");
    db.setTier(structuralRecent.id, "structural");
    db.setTier(coldRecent.id, "cold");

    const raw = db.getRawDb();
    raw
      .prepare(
        "UPDATE facts SET last_accessed = ?, recall_count = ?, access_count = ?, importance = ?, created_at = ? WHERE id = ?",
      )
      .run(1_000, 9, 9, 0.2, 100, hotHighAccess.id);
    raw
      .prepare(
        "UPDATE facts SET last_accessed = ?, recall_count = ?, access_count = ?, importance = ?, created_at = ? WHERE id = ?",
      )
      .run(1_000, 3, 3, 0.9, 200, hotHighImportance.id);
    raw
      .prepare(
        "UPDATE facts SET last_accessed = ?, recall_count = ?, access_count = ?, importance = ?, created_at = ? WHERE id = ?",
      )
      .run(900, 50, 50, 0.95, 300, hotOlderAccess.id);
    raw
      .prepare(
        "UPDATE facts SET last_accessed = ?, recall_count = ?, access_count = ?, importance = ?, created_at = ? WHERE id = ?",
      )
      .run(5_000, 1, 1, 0.8, 400, warmRecent.id);
    raw
      .prepare(
        "UPDATE facts SET last_accessed = ?, recall_count = ?, access_count = ?, importance = ?, created_at = ? WHERE id = ?",
      )
      .run(6_000, 1, 1, 0.7, 500, structuralRecent.id);
    raw
      .prepare(
        "UPDATE facts SET last_accessed = ?, recall_count = ?, access_count = ?, importance = ?, created_at = ? WHERE id = ?",
      )
      .run(7_000, 1, 1, 0.99, 600, coldRecent.id);
    raw
      .prepare(
        "UPDATE facts SET tier = ?, last_accessed = ?, recall_count = ?, access_count = ?, created_at = ? WHERE id = ?",
      )
      .run("experimental", 8_000, 999, 999, 700, unknownTier.id);

    expect(db.listFactIdsNeedingEntityEnrichment(50, 10)).toEqual([
      hotHighAccess.id,
      hotHighImportance.id,
      hotOlderAccess.id,
      warmRecent.id,
      structuralRecent.id,
      coldRecent.id,
      unknownTier.id,
    ]);
  });

  it("reports pending backlog totals by tier for enrichment progress", () => {
    const hot = db.store({
      text: "hot backlog fact with enough length for enrichment backlog accounting",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const warm = db.store({
      text: "warm backlog fact with enough length for enrichment backlog accounting",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const structural = db.store({
      text: "structural backlog fact with enough length for enrichment backlog accounting",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const cold = db.store({
      text: "cold backlog fact with enough length for enrichment backlog accounting",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const unknown = db.store({
      text: "unknown backlog fact with enough length for enrichment backlog accounting",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });

    db.setTier(hot.id, "hot");
    db.setTier(warm.id, "warm");
    db.setTier(structural.id, "structural");
    db.setTier(cold.id, "cold");
    db.getRawDb().prepare("UPDATE facts SET tier = ? WHERE id = ?").run("mystery", unknown.id);

    const summary = db.getEntityEnrichmentBacklogSummary(10);
    expect(summary.total).toBe(5);
    expect(summary.byTier).toEqual({
      hot: 1,
      warm: 1,
      structural: 1,
      cold: 1,
      unknown: 1,
    });
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

  it("suppresses duplicate logical mentions per fact via unique index/upsert", () => {
    const fact = db.store({
      text: "GitHub and GitHub were both mentioned.",
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
          label: "SERVICE",
          surfaceText: "GitHub",
          normalizedSurface: "github",
          startOffset: 0,
          endOffset: 6,
          confidence: 0.95,
        },
        {
          label: "SERVICE",
          surfaceText: "GitHub",
          normalizedSurface: "github",
          startOffset: 11,
          endOffset: 17,
          confidence: 0.94,
        },
      ],
      "eng",
    );
    const row = db
      .getRawDb()
      .prepare("SELECT COUNT(*) AS c FROM fact_entity_mentions WHERE fact_id = ?")
      .get(fact.id) as {
      c: number;
    };
    expect(row.c).toBe(1);
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
          surface_text: "Acme",
          normalized_surface: "acme",
        },
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
      expect(orgNames).toEqual([
        { display_name: "Acme" },
        { display_name: "Acme Corporation" },
        { display_name: "hybrid-memory pr pipeline" },
      ]);

      const contactCount = raw.prepare("SELECT COUNT(*) AS count FROM contacts").get() as { count: number };
      expect(contactCount.count).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("cleanup removes junk and reclassifies known rows", () => {
    const fact = db.store({
      text: "Gemini 3.1 Pro and API were mentioned by Surgeon.",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const now = Math.floor(Date.now() / 1000);
    const ins = db.getRawDb().prepare(
      `INSERT INTO fact_entity_mentions (
        id, fact_id, label, surface_text, normalized_surface, start_offset, end_offset, confidence, detected_lang, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run("a", fact.id, "ORG", "Gemini 3.1 Pro", "gemini", 0, 13, 0.9, "eng", "llm", now);
    ins.run("b", fact.id, "ORG", "api", "api", 20, 23, 0.9, "eng", "llm", now);
    ins.run("c", fact.id, "PERSON", "Surgeon", "surgeon", 28, 35, 0.95, "eng", "llm", now);

    const dryRun = db.cleanupEntityMentions({ limit: 50, apply: false });
    expect(dryRun.changedFacts).toBeGreaterThan(0);

    const applied = db.cleanupEntityMentions({ limit: 50, apply: true });
    expect(applied.changedFacts).toBeGreaterThan(0);
    const secondRun = db.cleanupEntityMentions({ limit: 50, apply: true });
    expect(secondRun.changedFacts).toBe(0);

    const rows = db
      .getRawDb()
      .prepare(
        "SELECT label, normalized_surface FROM fact_entity_mentions WHERE fact_id = ? ORDER BY normalized_surface",
      )
      .all(fact.id) as Array<{ label: string; normalized_surface: string }>;
    expect(rows).toEqual([{ label: "MODEL", normalized_surface: "gemini-3.1-pro" }]);
  });

  it("audit and cleanup count duplicates and substrings using canonicalized mention keys", () => {
    const fact = db.store({
      text: "GitHub and github are the same service mention.",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const now = Math.floor(Date.now() / 1000);
    const ins = db.getRawDb().prepare(
      `INSERT INTO fact_entity_mentions (
        id, fact_id, label, surface_text, normalized_surface, start_offset, end_offset, confidence, detected_lang, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run("d", fact.id, "ORG", "GitHub", "github", 0, 6, 0.9, "eng", "llm", now);
    ins.run("e", fact.id, "SERVICE", "github", "github", 11, 17, 0.89, "eng", "llm", now + 1);
    ins.run("f", fact.id, "SERVICE", "Hub", "hub", 3, 6, 0.88, "eng", "llm", now + 2);

    const audit = db.auditEntityMentions(50);
    const cleanupDryRun = db.cleanupEntityMentions({ limit: 50, apply: false });

    expect(audit.duplicates).toBe(1);
    expect(cleanupDryRun.duplicates).toBe(1);
    expect(audit.accepted).toBe(cleanupDryRun.accepted);
    expect(audit.rejected).toBe(cleanupDryRun.rejected);
    expect(audit.rejectReasons.substring).toBe(1);
  });

  it("counts reclassified mentions after substring filtering using retained rows only", () => {
    const fact = db.store({
      text: "Gemini 3.1 Pro supersedes Gemini 3.1 in this mention window.",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const now = Math.floor(Date.now() / 1000);
    const ins = db.getRawDb().prepare(
      `INSERT INTO fact_entity_mentions (
        id, fact_id, label, surface_text, normalized_surface, start_offset, end_offset, confidence, detected_lang, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run("j", fact.id, "ORG", "Gemini 3.1", "gemini 3.1", 0, 10, 0.9, "eng", "llm", now);
    ins.run("k", fact.id, "ORG", "Gemini 3.1 Pro", "gemini 3.1 pro", 0, 14, 0.95, "eng", "llm", now + 1);

    const audit = db.auditEntityMentions(50);
    const cleanupDryRun = db.cleanupEntityMentions({ limit: 50, apply: false });

    expect(audit.reclassified).toBe(1);
    expect(cleanupDryRun.reclassified).toBe(1);
  });

  it("does not reject substring mentions when offsets do not overlap", () => {
    const fact = db.store({
      text: "GitHub and Hub are separate mentions here.",
      entity: null,
      key: null,
      value: null,
      category: "other",
      importance: 0.5,
      source: "test",
    });
    const now = Math.floor(Date.now() / 1000);
    const ins = db.getRawDb().prepare(
      `INSERT INTO fact_entity_mentions (
        id, fact_id, label, surface_text, normalized_surface, start_offset, end_offset, confidence, detected_lang, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run("g", fact.id, "ORG", "GitHub", "github", 0, 6, 0.95, "eng", "llm", now);
    ins.run("h", fact.id, "SERVICE", "Hub", "hub", 11, 14, 0.9, "eng", "llm", now + 1);

    const audit = db.auditEntityMentions(50);
    const cleanupDryRun = db.cleanupEntityMentions({ limit: 50, apply: false });

    expect(audit.accepted).toBe(cleanupDryRun.accepted);
    expect(audit.rejected).toBe(cleanupDryRun.rejected);
    expect(audit.rejectReasons.substring ?? 0).toBe(0);
  });
});
