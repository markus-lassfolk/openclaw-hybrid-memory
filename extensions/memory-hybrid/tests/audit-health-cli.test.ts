import { describe, expect, it } from "vitest";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

describe("audit-health CLI support", () => {
  it("FactsDB exposes counts used by the audit-health report", () => {
    const db = new FactsDB(":memory:");
    const fact = db.store({
      text: "Audit health fact",
      category: "technical",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    expect(db.getCount()).toBeGreaterThanOrEqual(1);
    expect(db.countCanonicalEmbeddings()).toBeGreaterThanOrEqual(0);
    expect(db.countVectorlessActiveFacts()).toBeGreaterThanOrEqual(1);
    expect(db.vectorlessActiveFactsBySource()[0]).toMatchObject({ source: "test", count: expect.any(Number) });
    expect(db.statsBreakdownByTier()).toBeTypeOf("object");
    expect(db.statsBreakdownByDecayClass()).toBeTypeOf("object");
    expect(db.uniqueMemoryCategories()).toContain("technical");
    expect(db.statsBySource().test).toBeGreaterThanOrEqual(1);
    const triage = db.triageProcedures({ status: "validated", notPromoted: true });
    expect(triage.summary).toHaveProperty("byReason");
    expect(db.getById(fact.id)?.text).toBe("Audit health fact");
    db.close();
  });
});
