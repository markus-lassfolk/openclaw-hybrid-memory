/**
 * fact-extraction.test.ts — Dedicated unit tests for services/fact-extraction.ts.
 *
 * ## Coverage
 *
 * ### extractStructuredFields
 * - English decision patterns (decided/chose/picked/went with/selected/choosing)
 * - Swedish decision patterns (bestämde/valde)
 * - Preference-over patterns (use X over Y, chose X over Y)
 * - Convention rules (always/never/must/should always)
 * - Possessive constructs (X's ... is ..., My ... is ...)
 * - Swedish possessive (mitt/min ... är ...)
 * - Preference verbs (I prefer/like/love/hate/want)
 * - Swedish preference verbs (jag föredrar/gillar/...)
 * - Swedish name verb (heter ...)
 * - Email address extraction
 * - Phone number extraction
 * - Proper noun fallback for category=entity
 * - Returns all-null when nothing matches
 */

import { describe, expect, it } from "vitest";
import { extractStructuredFields } from "../services/fact-extraction.js";

// ---------------------------------------------------------------------------
// Decision patterns (English)
// ---------------------------------------------------------------------------

describe("extractStructuredFields — English decision patterns", () => {
  it("matches 'decided to use' pattern", () => {
    const r = extractStructuredFields("I decided to use TypeScript for the project", "decision");
    expect(r.entity).toBe("decision");
    expect(r.key).toContain("TypeScript");
  });

  it("matches 'chose' pattern", () => {
    const r = extractStructuredFields("We chose Postgres over MySQL because of reliability", "decision");
    expect(r.entity).toBe("decision");
    expect(r.key).toBeDefined();
  });

  it("matches 'went with' pattern", () => {
    const r = extractStructuredFields("We went with Next.js for the frontend", "decision");
    expect(r.entity).toBe("decision");
  });

  it("matches 'selected' pattern", () => {
    const r = extractStructuredFields("I selected Biome for linting", "decision");
    expect(r.entity).toBe("decision");
  });

  it("captures rationale when 'because' clause is present", () => {
    const r = extractStructuredFields("I decided to use Bun because of speed", "decision");
    expect(r.entity).toBe("decision");
    // Regex captures everything after "because " including "of"
    expect(r.value).toBe("of speed");
  });

  it("uses fallback rationale 'no rationale recorded' when no 'because' clause", () => {
    const r = extractStructuredFields("We chose Vite", "decision");
    expect(r.entity).toBe("decision");
    expect(r.value).toBe("no rationale recorded");
  });
});

// ---------------------------------------------------------------------------
// Swedish decision patterns
// ---------------------------------------------------------------------------

describe("extractStructuredFields — Swedish decision patterns", () => {
  it("matches 'bestämde' pattern", () => {
    const r = extractStructuredFields("Vi bestämde att använda TypeScript", "decision");
    expect(r.entity).toBe("decision");
    expect(r.key).toContain("TypeScript");
  });

  it("matches 'valde' pattern", () => {
    const r = extractStructuredFields("Jag valde Bun för hastigheten", "decision");
    expect(r.entity).toBe("decision");
  });
});

// ---------------------------------------------------------------------------
// Preference-over patterns
// ---------------------------------------------------------------------------

describe("extractStructuredFields — preference-over patterns", () => {
  it("matches 'use X over Y' pattern", () => {
    const r = extractStructuredFields("use tabs over spaces for indentation", "preference");
    expect(r.entity).toBe("decision");
    expect(r.key).toContain("tabs over spaces");
  });

  it("matches 'prefer X over Y' pattern", () => {
    const r = extractStructuredFields("I prefer dark mode over light mode", "preference");
    expect(r.entity).toBe("decision");
  });

  it("captures reason clause after 'because'", () => {
    const r = extractStructuredFields("use TypeScript over JavaScript because of type safety", "decision");
    // Regex captures everything after "because " including "of"
    expect(r.value).toBe("of type safety");
  });

  it("falls back to 'preference' value when no reason given", () => {
    // Uses choiceMatch path: "prefer X over Y" without a "because" clause
    const r = extractStructuredFields("I prefer tabs over spaces", "decision");
    expect(r.entity).toBe("decision");
    expect(r.value).toBe("preference");
  });
});

// ---------------------------------------------------------------------------
// Convention rules (always/never)
// ---------------------------------------------------------------------------

describe("extractStructuredFields — convention rules", () => {
  // #1190: "convention" is on the entity stopword list, so the heuristic extractor
  // no longer surfaces it as an entity. The rule's key/value still flow through.
  it("matches 'always' rule (entity nulled by stopword filter)", () => {
    const r = extractStructuredFields("always use semicolons in TypeScript", "decision");
    expect(r.entity).toBeNull();
    expect(r.key).toContain("use semicolons");
    expect(r.value).toBe("always");
  });

  it("matches 'never' rule", () => {
    const r = extractStructuredFields("never commit directly to main branch", "decision");
    expect(r.entity).toBeNull();
    expect(r.value).toBe("never");
  });

  it("matches 'must' rule", () => {
    const r = extractStructuredFields("must run tests before merging", "decision");
    expect(r.entity).toBeNull();
    expect(r.value).toBe("always");
  });

  it("matches Swedish 'alltid' (always)", () => {
    const r = extractStructuredFields("alltid använda semicolons", "decision");
    expect(r.entity).toBeNull();
    expect(r.value).toBe("always");
  });

  it("matches Swedish 'aldrig' (never)", () => {
    const r = extractStructuredFields("aldrig pusha till main", "decision");
    expect(r.entity).toBeNull();
    expect(r.value).toBe("never");
  });
});

// ---------------------------------------------------------------------------
// Possessive constructs
// ---------------------------------------------------------------------------

describe("extractStructuredFields — possessive constructs", () => {
  // #1190: "User"/"user" is on the entity stopword list. Key/value still flow through.
  it('matches "User\'s ... is ..." pattern (entity nulled)', () => {
    const r = extractStructuredFields("User's preferred editor is VS Code", "preference");
    expect(r.entity).toBeNull();
    expect(r.key).toBe("preferred editor");
    expect(r.value).toBe("VS Code");
  });

  it("matches 'My ... is ...' pattern (entity nulled)", () => {
    const r = extractStructuredFields("My favorite language is TypeScript", "preference");
    expect(r.entity).toBeNull();
    expect(r.key).toBe("favorite language");
    expect(r.value).toBe("TypeScript");
  });

  it("matches Swedish 'mitt ... är ...' pattern (entity nulled)", () => {
    const r = extractStructuredFields("mitt favoritspråk är TypeScript", "preference");
    expect(r.entity).toBeNull();
    expect(r.key).toBe("favoritspråk");
    expect(r.value).toBe("TypeScript");
  });

  it("matches Swedish 'min ... är ...' pattern (entity nulled)", () => {
    const r = extractStructuredFields("min editor är VS Code", "preference");
    expect(r.entity).toBeNull();
    expect(r.key).toBe("editor");
    expect(r.value).toBe("VS Code");
  });
});

// ---------------------------------------------------------------------------
// Preference verbs (English)
// ---------------------------------------------------------------------------

describe("extractStructuredFields — English preference verbs", () => {
  // #1190: "user" is on the entity stopword list — entity is nulled but key/value remain.
  it("matches 'I prefer' pattern (entity nulled)", () => {
    const r = extractStructuredFields("I prefer dark mode when coding", "preference");
    expect(r.entity).toBeNull();
    expect(r.key).toBe("prefer");
    expect(r.value).toBe("dark mode when coding");
  });

  it("matches 'I like' pattern (entity nulled)", () => {
    const r = extractStructuredFields("I like short commit messages", "preference");
    expect(r.entity).toBeNull();
    expect(r.key).toBe("like");
  });

  it("matches 'I use' pattern (without over/instead-of to avoid choiceMatch) (entity nulled)", () => {
    // "I use Bun" without "instead of/over" skips choiceMatch and hits preferMatch
    const r = extractStructuredFields("I use dark mode", "preference");
    expect(r.entity).toBeNull();
    expect(r.key).toBe("use");
    expect(r.value).toBe("dark mode");
  });
});

// ---------------------------------------------------------------------------
// Swedish preference verbs
// ---------------------------------------------------------------------------

describe("extractStructuredFields — Swedish preference verbs", () => {
  it("matches 'jag föredrar' pattern (entity nulled)", () => {
    const r = extractStructuredFields("jag föredrar mörkt läge", "preference");
    expect(r.entity).toBeNull();
    expect(r.key).toBe("föredrar");
    expect(r.value).toBe("mörkt läge");
  });

  it("matches 'jag gillar' pattern (entity nulled)", () => {
    const r = extractStructuredFields("jag gillar TypeScript", "preference");
    expect(r.entity).toBeNull();
    expect(r.key).toBe("gillar");
  });
});

// ---------------------------------------------------------------------------
// Swedish name verb (heter)
// ---------------------------------------------------------------------------

describe("extractStructuredFields — Swedish name verb (heter)", () => {
  it("matches 'heter' pattern", () => {
    const r = extractStructuredFields("Projektet heter MyApp", "entity");
    expect(r.entity).toBe("entity");
    expect(r.key).toBe("name");
    expect(r.value).toBe("MyApp");
  });
});

// ---------------------------------------------------------------------------
// Email and phone extraction
// ---------------------------------------------------------------------------

describe("extractStructuredFields — email extraction", () => {
  it("extracts email address", () => {
    const r = extractStructuredFields("contact us at support@example.com for help", "entity");
    expect(r.key).toBe("email");
    expect(r.value).toBe("support@example.com");
  });
});

describe("extractStructuredFields — phone extraction", () => {
  it("extracts phone number (10+ digits)", () => {
    const r = extractStructuredFields("call me at +12025551234 anytime", "entity");
    expect(r.key).toBe("phone");
    expect(r.value).toContain("12025551234");
  });
});

// ---------------------------------------------------------------------------
// Entity category fallback (proper nouns)
// ---------------------------------------------------------------------------

describe("extractStructuredFields — entity proper noun fallback", () => {
  it("returns first proper noun as entity when category is 'entity'", () => {
    const r = extractStructuredFields("Alice works on the project with Bob", "entity");
    expect(r.entity).toBe("Alice");
    expect(r.key).toBeNull();
    expect(r.value).toBeNull();
  });

  it("does NOT apply proper noun fallback for non-entity categories", () => {
    const r = extractStructuredFields("Alice works on the project", "fact");
    // No pattern matched — should return all nulls
    expect(r.entity).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No-match fallback
// ---------------------------------------------------------------------------

describe("extractStructuredFields — no-match fallback", () => {
  it("returns all null when nothing matches", () => {
    const r = extractStructuredFields("something with no recognizable pattern here", "fact");
    expect(r).toEqual({ entity: null, key: null, value: null });
  });

  it("handles empty string", () => {
    const r = extractStructuredFields("", "fact");
    expect(r).toEqual({ entity: null, key: null, value: null });
  });
});

// ---------------------------------------------------------------------------
// #1190: Entity stop-word integration — extractStructuredFields should never emit
// "User"/"user"/"convention"/"credentials" as an entity value.
// ---------------------------------------------------------------------------

describe("extractStructuredFields — entity stop-word filter (#1190)", () => {
  it("never returns 'User' as an entity for 'User's X is Y' constructs", () => {
    const r = extractStructuredFields("User's preferred editor is VS Code", "preference");
    expect(r.entity).toBeNull();
  });

  it("never returns 'user' as an entity for 'My X is Y' constructs", () => {
    const r = extractStructuredFields("My favorite editor is VS Code", "preference");
    expect(r.entity).toBeNull();
  });

  it("never returns 'convention' as an entity for 'always X' rules", () => {
    const r = extractStructuredFields("always use semicolons", "decision");
    expect(r.entity).toBeNull();
  });

  it("respects extra stopwords passed by caller", () => {
    const r = extractStructuredFields("Acme works on the project", "entity", { extraEntityStopWords: ["acme"] });
    expect(r.entity).toBeNull();
  });

  it("does not strip legitimate entities like 'decision' (not on stopword list)", () => {
    const r = extractStructuredFields("decided to use Vitest", "decision");
    expect(r.entity).toBe("decision");
  });
});
