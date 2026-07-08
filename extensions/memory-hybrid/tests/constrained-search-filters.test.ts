import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCandidateIdsByStructuredFilters } from "../backends/facts-db/search.js";
import { formatTimestampUtc } from "../utils/dates.js";
import { _testing } from "../index.js";

const { FactsDB, VerificationStore } = _testing;

const NOW_SEC = Math.floor(Date.parse("2026-06-05T12:00:00.000Z") / 1000);

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;
let verificationStore: InstanceType<typeof VerificationStore>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "constrained-search-filters-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  verificationStore = new VerificationStore(factsDb.getRawDb(), { reverificationDays: 30 });
});

afterEach(() => {
  verificationStore.close();
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getCandidateIdsByStructuredFilters — ISO TEXT enrollment filters", () => {
  it("returns actively verified facts and excludes unverified or overdue reverification", () => {
    const verifiedActive = factsDb.store({
      text: "Production API endpoint is api.example.com",
      category: "technical",
      importance: 0.9,
      entity: "api.example.com",
      key: "endpoint",
      value: "api.example.com",
      source: "conversation",
    });
    const unverified = factsDb.store({
      text: "Unverified preference",
      category: "preference",
      importance: 0.5,
      entity: "user",
      key: "theme",
      value: "dark",
      source: "conversation",
    });
    const verifiedOverdue = factsDb.store({
      text: "Stale credential host db.internal",
      category: "technical",
      importance: 0.9,
      entity: "db.internal",
      key: "host",
      value: "db.internal",
      source: "conversation",
    });

    verificationStore.verify(verifiedActive.id, verifiedActive.text, "system");
    verificationStore.verify(verifiedOverdue.id, verifiedOverdue.text, "system");

    const rawDb = factsDb.getRawDb();
    rawDb
      .prepare("UPDATE verified_facts SET next_verification = ? WHERE fact_id = ?")
      .run(formatTimestampUtc(NOW_SEC + 3600), verifiedActive.id);
    rawDb
      .prepare("UPDATE verified_facts SET next_verification = ? WHERE fact_id = ?")
      .run(formatTimestampUtc(NOW_SEC - 3600), verifiedOverdue.id);

    const ids = getCandidateIdsByStructuredFilters(
      rawDb,
      { verificationTier: "critical" },
      { limit: 100, nowSec: NOW_SEC },
    );

    expect(ids).toEqual([verifiedActive.id]);
    expect(ids).not.toContain(unverified.id);
    expect(ids).not.toContain(verifiedOverdue.id);
  });

  it("uses latest verified_facts version when deciding enrollment", () => {
    const fact = factsDb.store({
      text: "Rotating secret host vault.internal",
      category: "technical",
      importance: 0.9,
      entity: "vault.internal",
      key: "host",
      value: "vault.internal",
      source: "conversation",
    });

    verificationStore.verify(fact.id, fact.text, "system");
    const firstVersionId = verificationStore.getVerified(fact.id)!.id;
    verificationStore.update(firstVersionId, `${fact.text} v2`, "system");

    const rawDb = factsDb.getRawDb();
    rawDb
      .prepare("UPDATE verified_facts SET next_verification = ? WHERE fact_id = ? AND version = 1")
      .run(formatTimestampUtc(NOW_SEC - 3600), fact.id);
    rawDb
      .prepare("UPDATE verified_facts SET next_verification = ? WHERE fact_id = ? AND version = 2")
      .run(formatTimestampUtc(NOW_SEC + 3600), fact.id);

    const ids = getCandidateIdsByStructuredFilters(
      rawDb,
      { verificationTier: "warm" },
      { limit: 100, nowSec: NOW_SEC },
    );

    expect(ids).toEqual([fact.id]);
  });

  it("restricts candidates to the caller's own scope when scopeFilter is passed (loop iteration 24 regression)", () => {
    const aliceFact = factsDb.store({
      text: "Alice's constrained candidate",
      category: "technical",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "user",
      scopeTarget: "alice",
    });
    const bobFact = factsDb.store({
      text: "Bob's constrained candidate",
      category: "technical",
      importance: 0.95,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "user",
      scopeTarget: "bob",
    });

    const ids = getCandidateIdsByStructuredFilters(
      factsDb.getRawDb(),
      { category: "technical" },
      { limit: 100, nowSec: NOW_SEC, scopeFilter: { userId: "alice", agentId: null, sessionId: null } },
    );

    expect(ids).toContain(aliceFact.id);
    expect(ids).not.toContain(bobFact.id);
  });
});
