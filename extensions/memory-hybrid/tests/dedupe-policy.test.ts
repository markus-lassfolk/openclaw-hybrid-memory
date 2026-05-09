import { describe, expect, it } from "vitest";
import { parseStoreConfig } from "../config/parsers/core.js";
import { resolveDedupeProfile, shouldReportVectorDedupeFallback } from "../services/dedupe-policy.js";
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
  it("scopes exact-text dedupe to the same source (#1202)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupe-exact-source-scope-"));
    const db = new FactsDB(join(dir, "facts.db"), {
      fuzzyDedupe: true,
      storeConfig: { fuzzyDedupe: true, defaultProfile: { onDuplicate: "skip" } },
    });
    try {
      db.store({
        text: "same raw text different channels",
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "channel-a",
      });
      db.store({
        text: "same raw text different channels",
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "channel-b",
      });
      expect(db.count()).toBe(2);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      expect(rows[0].evicted).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evicts the lowest-confidence active fact on overflow when onOverflow=evict-lowest-confidence (#1194)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupe-profile-evict-"));
    const db = new FactsDB(join(dir, "facts.db"), {
      fuzzyDedupe: true,
      storeConfig: {
        fuzzyDedupe: true,
        sourceProfiles: {
          "noisy-evict": { maxPerDay: 1, onDuplicate: "store", onOverflow: "evict-lowest-confidence" },
        },
      },
    });
    try {
      const victim = db.store({
        text: "low-confidence stale fact",
        category: "fact",
        importance: 0.1,
        entity: null,
        key: null,
        value: null,
        source: "noisy-evict",
        confidence: 0.2,
      });
      const winner = db.store({
        text: "fresh high-confidence write",
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "noisy-evict",
        confidence: 0.9,
      });
      expect(winner.id).not.toBe(victim.id);
      const rows = db.statsDailyWrites();
      const noisy = rows.find((r) => r.source === "noisy-evict");
      expect(noisy?.dropped ?? 0).toBe(0);
      expect(noisy?.evicted).toBe(1);
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

  it("honours vectorThreshold via caller-supplied vectorCandidates and bumps recall on the winner (#1186, #1194)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupe-profile-vector-"));
    const db = new FactsDB(join(dir, "facts.db"), {
      fuzzyDedupe: true,
      storeConfig: {
        fuzzyDedupe: true,
        sourceProfiles: { "implicit-feedback": { onDuplicate: "skip", vectorThreshold: 0.85 } },
      },
    });
    try {
      const original = db.store({
        text: "user prefers concise summaries when reviewing PRs",
        category: "technical",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "implicit-feedback",
      });
      const initialRecall = original.recallCount ?? 0;
      const stored = db.store(
        {
          text: "Concise summaries are preferred for PR reviews by the user",
          category: "technical",
          importance: 0.5,
          entity: null,
          key: null,
          value: null,
          source: "implicit-feedback",
        },
        { vectorCandidates: [{ id: original.id, score: 0.9 }] },
      );
      expect(stored.id).toBe(original.id);
      expect((stored.recallCount ?? 0) - initialRecall).toBeGreaterThanOrEqual(1);
      expect(db.count()).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports vector fallback telemetry only when the policy can actually fall back to lexical-only", () => {
    expect(
      shouldReportVectorDedupeFallback({
        fuzzyDedupe: true,
        storeConfig: { fuzzyDedupe: true, defaultProfile: { vectorThreshold: 0.9, onDuplicate: "skip" } },
        source: "directive:session.jsonl",
      }),
    ).toBe(true);

    expect(
      shouldReportVectorDedupeFallback({
        fuzzyDedupe: false,
        storeConfig: { fuzzyDedupe: false, defaultProfile: { vectorThreshold: 0.9, onDuplicate: "skip" } },
        source: "directive:session.jsonl",
      }),
    ).toBe(false);

    expect(
      shouldReportVectorDedupeFallback({
        fuzzyDedupe: true,
        storeConfig: { fuzzyDedupe: true, sourceProfiles: { "directive:*": { onDuplicate: "store" } } },
        source: "directive:session.jsonl",
      }),
    ).toBe(false);

    expect(
      shouldReportVectorDedupeFallback({
        fuzzyDedupe: true,
        storeConfig: { fuzzyDedupe: true, defaultProfile: { vectorThreshold: 0.9, onDuplicate: "skip" } },
        source: "directive:session.jsonl",
        vectorCandidates: [{ id: "existing", score: 0.95 }],
      }),
    ).toBe(false);
  });

  it("emits vector-candidates-missing warning once per warnContext and supports suppression (#1194)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupe-profile-warn-once-"));
    const db = new FactsDB(join(dir, "facts.db"), {
      fuzzyDedupe: true,
      storeConfig: { fuzzyDedupe: true, defaultProfile: { vectorThreshold: 0.9, onDuplicate: "skip" } },
    });
    const stderrWrite = process.stderr.write;
    const warns: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warns.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      db.store(
        {
          text: "first fact no vector candidates",
          category: "fact",
          importance: 0.5,
          entity: null,
          key: null,
          value: null,
          source: "warn-test",
        },
        { warnContext: "phase-a" },
      );
      db.store(
        {
          text: "second fact same phase no vector candidates",
          category: "fact",
          importance: 0.5,
          entity: null,
          key: null,
          value: null,
          source: "warn-test",
        },
        { warnContext: "phase-a" },
      );
      db.store(
        {
          text: "third fact different phase no vector candidates",
          category: "fact",
          importance: 0.5,
          entity: null,
          key: null,
          value: null,
          source: "warn-test",
        },
        { warnContext: "phase-b" },
      );
      db.store(
        {
          text: "fourth fact suppressed warning",
          category: "fact",
          importance: 0.5,
          entity: null,
          key: null,
          value: null,
          source: "warn-test",
        },
        { warnContext: "phase-c", suppressVectorFallbackWarning: true },
      );

      expect(warns.length).toBe(2);
      expect(warns[0]).toMatch(/store dedupe/i);
      expect(warns[0]).toMatch(/vectorThreshold=0.9/);
      expect(warns[1]).toMatch(/store dedupe/i);
    } finally {
      process.stderr.write = stderrWrite;
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
