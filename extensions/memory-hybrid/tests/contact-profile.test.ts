/**
 * Structured contact profile enrichment (#2014).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import { mergeContacts, normalizeEntityKey } from "../backends/facts-db/entity-layer.js";
import {
  enrichContactProfileFromStoredFact,
  extractContactProfileFromText,
  parseContactsMarkdown,
  runContactsImport,
} from "../services/contact-profile.js";

describe("extractContactProfileFromText", () => {
  it("extracts email and role from a person fact", () => {
    const profile = extractContactProfileFromText(
      "Daniel Thunberg email daniel.thunberg@avoki.com Sverigechef Avoki",
      "Daniel Thunberg",
    );
    expect(profile.email).toBe("daniel.thunberg@avoki.com");
    expect(profile.displayName).toBe("Daniel Thunberg");
    expect(profile.role?.toLowerCase()).toContain("sverigechef");
  });
});

describe("parseContactsMarkdown", () => {
  it("parses org sections, board grouping, and contact lines", () => {
    const sections = parseContactsMarkdown(`
# Avoki

## Board
- Daniel Thunberg — daniel.thunberg@avoki.com — Sverigechef

## Management
- Anna Example | anna@avoki.com | CFO
`);
    expect(sections).toHaveLength(2);
    expect(sections[0].organization).toBe("Avoki");
    expect(sections[0].boardStatus).toBe("board");
    expect(sections[0].contacts[0]).toMatchObject({
      displayName: "Daniel Thunberg",
      email: "daniel.thunberg@avoki.com",
      role: "Sverigechef",
      boardStatus: "board",
    });
    expect(sections[1].boardStatus).toBe("management");
  });
});

describe("contact profile enrichment on store", () => {
  let dir: string;
  let db: FactsDB;

  const storeEntry = (input: Parameters<FactsDB["store"]>[0]) => {
    const entry = db.store(input);
    if (!entry.id) {
      throw new Error("store returned placeholder entry without id");
    }
    return entry;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "contact-profile-"));
    db = new FactsDB(join(dir, "facts.db"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("updates contacts.email and role when storing a matching person fact", () => {
    db.applyEntityEnrichment(
      storeEntry({
        text: "Daniel Thunberg works at Avoki.",
        entity: "Daniel Thunberg",
        category: "entity",
        source: "test",
        importance: 0.5,
      }).id,
      [
        {
          label: "PERSON",
          surfaceText: "Daniel Thunberg",
          normalizedSurface: "daniel thunberg",
          startOffset: 0,
          endOffset: 15,
          confidence: 0.9,
        },
      ],
      "eng",
    );

    const fact = storeEntry({
      text: "Daniel Thunberg email daniel.thunberg@avoki.com Sverigechef Avoki",
      entity: "Daniel Thunberg",
      category: "entity",
      source: "test",
      importance: 0.7,
    });

    const contacts = db.listContactsByNamePrefix("Daniel", 10);
    expect(contacts.some((c) => c.email === "daniel.thunberg@avoki.com")).toBe(true);
    const match = contacts.find((c) => normalizeEntityKey(c.displayName) === "daniel thunberg");
    expect(match?.role?.toLowerCase()).toContain("sverigechef");

    const enrich = enrichContactProfileFromStoredFact(db.getRawDb(), fact.id, {
      text: fact.text,
      entity: fact.entity,
      key: fact.key,
      value: fact.value,
    });
    expect(enrich.updated).toBe(true);
  });

  it("merges duplicate contacts via mergeContacts", () => {
    db.applyEntityEnrichment(
      storeEntry({
        text: "Daniel from Avoki",
        entity: null,
        category: "other",
        source: "test",
        importance: 0.5,
      }).id,
      [
        {
          label: "PERSON",
          surfaceText: "Daniel",
          normalizedSurface: "daniel",
          startOffset: 0,
          endOffset: 6,
          confidence: 0.8,
        },
      ],
      "eng",
    );
    db.applyEntityEnrichment(
      storeEntry({
        text: "Daniel Thunberg leads Avoki",
        entity: null,
        category: "other",
        source: "test",
        importance: 0.5,
      }).id,
      [
        {
          label: "PERSON",
          surfaceText: "Daniel Thunberg",
          normalizedSurface: "daniel thunberg",
          startOffset: 0,
          endOffset: 15,
          confidence: 0.9,
        },
      ],
      "eng",
    );

    const summary = mergeContacts(db.getRawDb(), "daniel thunberg", "daniel");
    expect(summary.canonicalId).toBeTruthy();
    expect(db.listContactsByNamePrefix("", 50)).toHaveLength(1);
  });

  it("imports CONTACTS.md idempotently into contacts and org links", () => {
    const mdPath = join(dir, "CONTACTS.md");
    writeFileSync(
      mdPath,
      `# Avoki\n\n## Board\n- Daniel Thunberg — daniel.thunberg@avoki.com — Sverigechef\n`,
      "utf8",
    );
    const content = parseContactsMarkdown(readFileSync(mdPath, "utf8"));
    const first = runContactsImport(
      db.getRawDb(),
      content,
      {
        storeFact: (input) =>
          storeEntry({
            text: input.text,
            entity: input.entity,
            category: input.category as "entity",
            source: input.source,
            importance: input.importance,
          }),
        createLink: (s, t, type, strength) => db.createLink(s, t, type, strength),
      },
      { linkPartOf: true },
    );
    const second = runContactsImport(
      db.getRawDb(),
      content,
      {
        storeFact: (input) =>
          storeEntry({
            text: input.text,
            entity: input.entity,
            category: input.category as "entity",
            source: input.source,
            importance: input.importance,
          }),
        createLink: (s, t, type, strength) => db.createLink(s, t, type, strength),
      },
      { linkPartOf: true },
    );

    expect(first.contactsUpserted).toBeGreaterThan(0);
    const listed = db.listContactsByNamePrefix("Daniel", 10);
    expect(listed.some((c) => c.email === "daniel.thunberg@avoki.com")).toBe(true);
    expect(second.dryRun).toBe(false);
    expect(db.listContactsByNamePrefix("Daniel", 10)).toHaveLength(listed.length);
  });

  it("resolves prefix NER names to full contacts when unambiguous", () => {
    db.applyEntityEnrichment(
      storeEntry({
        text: "Daniel Thunberg is Sverigechef",
        entity: null,
        category: "other",
        source: "test",
        importance: 0.5,
      }).id,
      [
        {
          label: "PERSON",
          surfaceText: "Daniel Thunberg",
          normalizedSurface: "daniel thunberg",
          startOffset: 0,
          endOffset: 15,
          confidence: 0.95,
        },
      ],
      "eng",
    );

    db.applyEntityEnrichment(
      storeEntry({
        text: "Daniel confirmed the budget",
        entity: null,
        category: "other",
        source: "test",
        importance: 0.5,
      }).id,
      [
        {
          label: "PERSON",
          surfaceText: "Daniel",
          normalizedSurface: "daniel",
          startOffset: 0,
          endOffset: 6,
          confidence: 0.8,
        },
      ],
      "eng",
    );

    expect(db.listContactsByNamePrefix("", 50)).toHaveLength(1);
  });
});
