import { describe, expect, it } from "vitest";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

describe("dedupe-policy integration — implicit-feedback path (Issue #1194)", () => {
  it("maxPerDay caps inserts; normalized-hash boost collapses whitespace variants; Jaccard catches paraphrases", () => {
    const storeConfig = {
      fuzzyDedupe: true,
      defaultProfile: { onDuplicate: "skip" as const },
      sourceProfiles: {
        "implicit-feedback": {
          maxPerDay: 5,
          lexicalJaccard: 0.8,
          onDuplicate: "boost" as const,
          boostBy: 0.05,
        },
      },
    };

    const db = new FactsDB(":memory:", { fuzzyDedupe: true, storeConfig });
    const base = "user prefers dark mode for ide and terminal sessions when working at night and avoids bright themes";

    /** Unique raw suffix in Unicode space-separator range; normalizes away so normalized_hash matches. */
    const uniqueImplicitWsSuffix = (i: number): string => {
      let s = "";
      let n = i;
      for (let k = 0; k < 4; k++) {
        s += String.fromCharCode(0x2000 + (n % 11));
        n = Math.floor(n / 11);
      }
      return s;
    };

    let canonicalId = "";
    for (let i = 0; i < 1000; i++) {
      const text = `  ${base}  ${uniqueImplicitWsSuffix(i)}`;
      const e = db.store({
        text,
        category: "technical",
        importance: 0.5,
        entity: null,
        key: "implicit_feedback_signal",
        value: text.slice(0, 120),
        source: "implicit-feedback",
        tags: ["implicit-feedback", "test"],
        decayClass: "normal",
      });
      if (i === 0) canonicalId = e.id;
      else expect(e.id).toBe(canonicalId);
    }

    const implicitCount = db.statsBySource()["implicit-feedback"] ?? 0;
    expect(implicitCount).toBe(1);

    const raw = db.getRawDb();
    const recall = raw.prepare(`SELECT recall_count FROM facts WHERE id = ?`).get(canonicalId) as {
      recall_count: number;
    };
    expect(recall.recall_count).toBeGreaterThanOrEqual(999);

    // Four lessons with low token overlap vs `base` so lexicalJaccard=0.8 does not boost the canonical row.
    const extraLessons = [
      "postgres partial index on archived_at for churn queries zlesson1",
      "kubernetes pod disruption budget when upgrading node pools zlesson2",
      "s3 lifecycle transition to glacier after ninety days rule zlesson3",
      "grpc deadline propagation across service mesh hops zlesson4",
    ];
    for (const text of extraLessons) {
      db.store({
        text,
        category: "technical",
        importance: 0.5,
        entity: null,
        key: "implicit_feedback_signal",
        value: text.slice(0, 80),
        source: "implicit-feedback",
        tags: ["implicit-feedback"],
        decayClass: "normal",
      });
    }
    expect(db.statsBySource()["implicit-feedback"]).toBe(5);

    let quotaHits = 0;
    for (let i = 0; i < 50; i++) {
      try {
        db.store({
          text: `totally unrelated lesson content number ${i} xyz123`,
          category: "technical",
          importance: 0.5,
          entity: null,
          key: "implicit_feedback_signal",
          value: "q",
          source: "implicit-feedback",
          tags: ["implicit-feedback"],
          decayClass: "normal",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("daily write quota exceeded")) quotaHits++;
        else throw e;
      }
    }
    expect(quotaHits).toBeGreaterThan(0);

    db.close();
  });
});
