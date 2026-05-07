import { describe, expect, it } from "vitest";
import { parseStoreConfig } from "../config/parsers/core.js";
import { resolveDedupeProfile } from "../services/dedupe-policy.js";
import { normalizedHash } from "../utils/tags.js";

describe("dedupe policy", () => {
  it("resolves exact source profiles", () => {
    const store = parseStoreConfig({
      store: { sourceProfiles: { "implicit-feedback": { onDuplicate: "boost", maxPerDay: 50, boostBy: 0.2 } } },
    });
    const profile = resolveDedupeProfile("implicit-feedback", store);
    expect(profile.sourcePattern).toBe("implicit-feedback");
    expect(profile.onDuplicate).toBe("boost");
    expect(profile.maxPerDay).toBe(50);
    expect(profile.boostBy).toBe(0.2);
  });

  it("resolves glob source profiles before falling back", () => {
    const store = parseStoreConfig({
      store: { sourceProfiles: { "seed:*": { onDuplicate: "store" } }, defaultProfile: { onDuplicate: "skip" } },
    });
    expect(resolveDedupeProfile("seed:demo", store).onDuplicate).toBe("store");
    expect(resolveDedupeProfile("conversation", store).onDuplicate).toBe("skip");
  });

  it("uses sane defaults when no profile matches", () => {
    const profile = resolveDedupeProfile("whatever", parseStoreConfig({ store: {} }));
    expect(profile.onDuplicate).toBe("skip");
    expect(profile.vectorThreshold).toBe(0.95);
    expect(profile.lexicalJaccard).toBe(0.9);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

describe("FactsDB sourceProfiles write path", () => {
  it("bypasses duplicate suppression for onDuplicate=store", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupe-profile-store-"));
    const db = new FactsDB(join(dir, "facts.db"), {
      fuzzyDedupe: true,
      storeConfig: { fuzzyDedupe: true, sourceProfiles: { "seed:*": { onDuplicate: "store" } } },
    });
    try {
      db.store({
        text: "same seed fact",
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "seed:demo",
      });
      db.store({
        text: "same seed fact",
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "seed:demo",
      });
      expect(db.count()).toBe(2);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes normalized_hash when onDuplicate=merge extends text", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupe-profile-merge-"));
    const db = new FactsDB(join(dir, "facts.db"), {
      fuzzyDedupe: true,
      storeConfig: {
        fuzzyDedupe: true,
        sourceProfiles: { "merge-test": { onDuplicate: "merge" } },
      },
    });
    try {
      // Same normalized form as second insert (hash match) but not a substring merge, so text is concatenated.
      const first = db.store({
        text: "Alpha   Bravo",
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "merge-test",
      });
      const merged = db.store({
        text: "alpha bravo",
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "merge-test",
      });
      expect(merged.id).toBe(first.id);
      expect(merged.text).toBe("Alpha   Bravo\nalpha bravo");
      const expectedHash = normalizedHash(merged.text);
      const raw = db.getRawDb();
      const row = raw.prepare("SELECT normalized_hash FROM facts WHERE id = ?").get(first.id) as
        | { normalized_hash: string }
        | undefined;
      expect(row?.normalized_hash).toBe(expectedHash);

      const third = db.store({
        text: "alpha bravo alpha bravo",
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "merge-test",
      });
      expect(third.id).toBe(first.id);
      expect(db.count()).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boosts canonical facts for onDuplicate=boost", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupe-profile-boost-"));
    const db = new FactsDB(join(dir, "facts.db"), {
      fuzzyDedupe: true,
      storeConfig: {
        fuzzyDedupe: true,
        sourceProfiles: { "implicit-feedback": { onDuplicate: "boost", boostBy: 0.2 } },
      },
    });
    try {
      const first = db.store({
        text: "assistant should avoid vague replies",
        category: "technical",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "implicit-feedback",
      });
      const second = db.store({
        text: "assistant should avoid vague replies",
        category: "technical",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "implicit-feedback",
      });
      expect(second.id).toBe(first.id);
      const boosted = db.getById(first.id)!;
      expect(boosted.recallCount).toBeGreaterThanOrEqual(1);
      expect(boosted.importance).toBeCloseTo(0.7, 5);
      expect(db.count()).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces maxPerDay per source and records drops", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupe-profile-quota-"));
    const db = new FactsDB(join(dir, "facts.db"), {
      fuzzyDedupe: true,
      storeConfig: { fuzzyDedupe: true, sourceProfiles: { noisy: { maxPerDay: 1, onDuplicate: "skip" } } },
    });
    try {
      db.store({
        text: "first noisy write",
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "noisy",
      });
      expect(() =>
        db.store({
          text: "second noisy write",
          category: "fact",
          importance: 0.5,
          entity: null,
          key: null,
          value: null,
          source: "noisy",
        }),
      ).toThrow(/daily write quota exceeded/);
      const rows = db.statsDailyWrites();
      expect(rows[0].source).toBe("noisy");
      expect(rows[0].count).toBe(1);
      expect(rows[0].dropped).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies onDuplicate=boost when at maxPerDay (duplicate path does not consume quota)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupe-profile-quota-boost-"));
    const db = new FactsDB(join(dir, "facts.db"), {
      fuzzyDedupe: true,
      storeConfig: {
        fuzzyDedupe: true,
        sourceProfiles: { "quota-boost": { maxPerDay: 1, onDuplicate: "boost", boostBy: 0.2 } },
      },
    });
    try {
      const first = db.store({
        text: "canonical quota boost fact",
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "quota-boost",
      });
      const second = db.store({
        text: "canonical quota boost fact",
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "quota-boost",
      });
      expect(second.id).toBe(first.id);
      expect(second.recallCount).toBeGreaterThanOrEqual(1);
      expect(second.importance).toBeCloseTo(0.7, 5);
      expect(db.count()).toBe(1);
      expect(() =>
        db.store({
          text: "different fact same day",
          category: "fact",
          importance: 0.5,
          entity: null,
          key: null,
          value: null,
          source: "quota-boost",
        }),
      ).toThrow(/daily write quota exceeded/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
