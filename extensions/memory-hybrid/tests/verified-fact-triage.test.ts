import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { PendingAutopilotStore, computePendingInputHash } from "../services/pending-autopilot/index.js";
import { VerificationStore } from "../services/verification-store.js";
import {
  VERIFIED_REVIEW_QUEUE_SOURCE,
  VERIFIED_TRIAGE_POLICY_VERSION,
  assertVerifiedTriagePolicy,
  classifyVerifiedFact,
  createVerifiedFactTriageAdapter,
  listVerifiedFactTriageItems,
  runVerifiedFactTriage,
  runVerifiedFactTriageWithAdapter,
  type VerifiedFactTriageItem,
} from "../services/verified-fact-triage.js";
import { expectStandaloneAndParentDecisionsEquivalent } from "./helpers/pending-autopilot-equivalence.js";

let tmpDir: string;
let factsDb: FactsDB;
let verificationStore: VerificationStore;
let pendingStore: PendingAutopilotStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "verified-triage-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  verificationStore = new VerificationStore(factsDb.getRawDb(), {
    backupPath: join(tmpDir, "verified.json"),
    reverificationDays: 30,
  });
  pendingStore = new PendingAutopilotStore(join(tmpDir, "pending.db"));
});

afterEach(() => {
  pendingStore.close();
  verificationStore.close();
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function addFact(
  id: string,
  text: string,
  opts: Partial<Parameters<FactsDB["store"]>[0]> & {
    verified?: boolean;
    due?: boolean;
    verificationTier?: string;
  } = {},
): string {
  factsDb
    .getRawDb()
    .prepare(
      "INSERT INTO facts (id, text, category, importance, entity, key, value, source, created_at, decay_class, expires_at, last_confirmed_at, confidence, tags, valid_from, valid_until, supersedes_id, tier, scope, scope_target, source_sessions, provenance_session, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      text,
      opts.category ?? "fact",
      opts.importance ?? 0.8,
      opts.entity ?? null,
      opts.key ?? null,
      opts.value ?? null,
      opts.source ?? "test",
      Math.floor(Date.now() / 1000),
      opts.decayClass ?? "durable",
      opts.expiresAt ?? null,
      Math.floor(Date.now() / 1000),
      opts.confidence ?? 0.95,
      opts.tags?.join(",") ?? null,
      opts.validFrom ?? null,
      opts.validUntil ?? null,
      opts.supersedesId ?? null,
      opts.verificationTier ?? "warm",
      opts.scope ?? "global",
      opts.scope === "global" || !opts.scope ? null : (opts.scopeTarget ?? null),
      opts.sourceSessions ?? null,
      opts.provenanceSession ?? null,
      opts.provenanceJson ?? null,
    );
  /* factsDb.store({
    text,
    category: opts.category ?? "fact",
    importance: opts.importance ?? 0.8,
    confidence: opts.confidence ?? 0.95,
    source: opts.source ?? "test",
    decayClass: opts.decayClass ?? "durable",
    entity: opts.entity,
    key: opts.key,
    value: opts.value,
    tags: opts.tags,
    expiresAt: opts.expiresAt,
    validFrom: opts.validFrom,
    validUntil: opts.validUntil,
    supersedesId: opts.supersedesId,
    scope: opts.scope,
    scopeTarget: opts.scopeTarget,
    provenanceSession: opts.provenanceSession,
    sourceSessions: opts.sourceSessions,
    provenanceJson: opts.provenanceJson,
  });
  */
  if (opts.verified !== false) {
    verificationStore.verify(id, text, "user");
    if (opts.due !== false) {
      factsDb
        .getRawDb()
        .prepare("UPDATE verified_facts SET next_verification = ? WHERE fact_id = ?")
        .run("2000-01-01T00:00:00.000Z", id);
    }
  }
  return id;
}

function oneItem(id: string): VerifiedFactTriageItem {
  const item = listVerifiedFactTriageItems(factsDb.getRawDb(), {
    max: 100,
  }).find((candidate) => candidate.payload.verified.factId === id);
  if (!item) throw new Error(`missing triage item ${id}`);
  return item;
}

function bucket(id: string) {
  return classifyVerifiedFact(oneItem(id), {
    db: factsDb.getRawDb(),
    nowMs: Date.parse("2026-05-12T00:00:00Z"),
    policy: "classify",
  });
}

describe("verified fact triage queue source and policy", () => {
  it("uses due-for-reverification latest verified facts, not all verified facts", () => {
    addFact("due", "Due verified fact", { provenanceJson: "{}" });
    addFact("stale-verified-at", "Stale verified_at fact", {
      provenanceJson: "{}",
      due: false,
    });
    addFact("not-due", "Not due verified fact", {
      provenanceJson: "{}",
      due: false,
    });
    factsDb
      .getRawDb()
      .prepare("UPDATE verified_facts SET verified_at = ? WHERE fact_id = ?")
      .run("2026-03-01T00:00:00.000Z", "stale-verified-at");
    const items = listVerifiedFactTriageItems(factsDb.getRawDb(), {
      max: 10,
      nowMs: Date.parse("2026-05-12T00:00:00Z"),
    });
    expect(VERIFIED_REVIEW_QUEUE_SOURCE).toContain("due");
    expect(items.map((i) => i.payload.verified.factId)).toEqual(["due", "stale-verified-at"]);
    expect(items.find((i) => i.payload.verified.factId === "stale-verified-at")?.payload.dueReason).toBe(
      "verified_at_stale",
    );
  });

  it("uses configured reverificationDays for stale verified_at cutoff", async () => {
    addFact("windowed", "Windowed stale fact", {
      provenanceJson: "{}",
      due: false,
    });
    factsDb
      .getRawDb()
      .prepare("UPDATE verified_facts SET verified_at = ? WHERE fact_id = ?")
      .run("2026-05-01T00:00:00.000Z", "windowed");

    const tightWindow = await runVerifiedFactTriage(factsDb, {
      mode: "dry-run",
      policy: "classify",
      nowMs: Date.parse("2026-05-12T00:00:00Z"),
      reverificationDays: 7,
    });
    expect(tightWindow.items.map((item) => item.factId)).toEqual(["windowed"]);

    const wideWindow = await runVerifiedFactTriage(factsDb, {
      mode: "dry-run",
      policy: "classify",
      nowMs: Date.parse("2026-05-12T00:00:00Z"),
      reverificationDays: 30,
    });
    expect(wideWindow.counts.inspected).toBe(0);
  });

  it("filters checksum-corrupted verified rows before triage", () => {
    addFact("good", "Good verified fact", { provenanceJson: "{}" });
    addFact("corrupt", "Corrupt verified fact", { provenanceJson: "{}" });
    factsDb
      .getRawDb()
      .prepare("UPDATE verified_facts SET canonical_text = ? WHERE fact_id = ?")
      .run("tampered", "corrupt");
    const items = listVerifiedFactTriageItems(factsDb.getRawDb(), { max: 10 });
    expect(items.map((i) => i.payload.verified.factId)).toEqual(["good"]);
  });

  it("applies max after bounded checksum-filtered SQL overfetch", () => {
    addFact("corrupt-first", "Corrupt earliest fact", { provenanceJson: "{}" });
    addFact("valid-second", "Valid later fact", { provenanceJson: "{}" });
    factsDb
      .getRawDb()
      .prepare("UPDATE verified_facts SET canonical_text = ? WHERE fact_id = ?")
      .run("tampered", "corrupt-first");
    factsDb
      .getRawDb()
      .prepare("UPDATE verified_facts SET next_verification = ? WHERE fact_id = ?")
      .run("1999-01-01T00:00:00.000Z", "corrupt-first");
    factsDb
      .getRawDb()
      .prepare("UPDATE verified_facts SET next_verification = ? WHERE fact_id = ?")
      .run("2000-01-01T00:00:00.000Z", "valid-second");

    const preparedSql: string[] = [];
    const db = factsDb.getRawDb();
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      preparedSql.push(sql);
      return originalPrepare(sql);
    }) as typeof db.prepare;

    const items = listVerifiedFactTriageItems(db, { max: 1 });

    expect(items.map((i) => i.payload.verified.factId)).toEqual(["valid-second"]);
    expect(preparedSql.some((sql) => /LIMIT \?/i.test(sql))).toBe(true);
  });

  it("paginates bounded overfetch until enough checksum-valid rows are found", () => {
    for (let i = 0; i < 25; i += 1) {
      const id = `corrupt-${i.toString().padStart(2, "0")}`;
      addFact(id, `Corrupt fact ${i}`, { provenanceJson: "{}" });
      factsDb
        .getRawDb()
        .prepare("UPDATE verified_facts SET canonical_text = ?, next_verification = ? WHERE fact_id = ?")
        .run("tampered", `1999-01-${(i + 1).toString().padStart(2, "0")}T00:00:00.000Z`, id);
    }
    addFact("valid-after-page", "Valid after first bounded page", { provenanceJson: "{}" });
    factsDb
      .getRawDb()
      .prepare("UPDATE verified_facts SET next_verification = ? WHERE fact_id = ?")
      .run("2000-01-01T00:00:00.000Z", "valid-after-page");

    const items = listVerifiedFactTriageItems(factsDb.getRawDb(), { max: 1 });

    expect(items.map((i) => i.payload.verified.factId)).toEqual(["valid-after-page"]);
  });

  it("report-only and dry-run never mutate foundation state", async () => {
    addFact("current", "A sourced current fact", { provenanceJson: "{}" });
    const before = pendingStore.tableCounts();
    const result = await runVerifiedFactTriage(factsDb, {
      mode: "dry-run",
      policy: "report-only",
      store: pendingStore,
    });
    expect(result.counts.inspected).toBe(1);
    expect(pendingStore.tableCounts()).toEqual(before);
  });

  it("report-only + apply stays non-mutating", async () => {
    addFact("report-only-apply", "A sourced current fact", {
      provenanceJson: "{}",
    });
    const before = pendingStore.tableCounts();
    const result = await runVerifiedFactTriage(factsDb, {
      mode: "apply",
      policy: "report-only",
      store: pendingStore,
    });
    expect(result.counts.inspected).toBe(1);
    expect(result.counts.applied).toBe(0);
    expect(pendingStore.tableCounts()).toEqual(before);
  });

  it("classify persists only non-destructive classification metadata", async () => {
    addFact("classify-me", "A sourced fact due for review", {
      provenanceJson: "{}",
    });
    const result = await runVerifiedFactTriage(factsDb, {
      mode: "apply",
      policy: "classify",
      store: pendingStore,
    });
    expect(result.items[0].action).toBe("classified");
    expect(pendingStore.listDecisions({ queue: "verified" })).toHaveLength(1);
    expect(factsDb.getById("classify-me")?.text).toBe("A sourced fact due for review");
  });

  it("requires a durable store for non-report apply runs", async () => {
    addFact("needs-store", "A sourced fact that must persist apply metadata", {
      provenanceJson: "{}",
    });

    await expect(
      runVerifiedFactTriage(factsDb, {
        mode: "apply",
        policy: "classify",
      }),
    ).rejects.toThrow(/requires a PendingAutopilotStore/);
  });

  it("apply-obvious cannot delete, demote, rewrite, or change critical verified facts", async () => {
    addFact("critical", "Critical but non-sensitive sourced fact", {
      provenanceJson: "{}",
      verificationTier: "critical",
    });
    const before = factsDb.getById("critical");
    expect(before).not.toBeNull();
    await runVerifiedFactTriage(factsDb, {
      mode: "apply",
      policy: "apply-obvious",
      store: pendingStore,
    });
    const after = factsDb.getById("critical");
    expect(after).not.toBeNull();
    expect(after?.text).toBe(before?.text);
    expect(after?.tier).toBe(before?.tier);
    expect(verificationStore.getVerified("critical")?.canonicalText).toBe("Critical but non-sensitive sourced fact");
  });
});

describe("verified fact triage classification buckets and evidence", () => {
  it("classifies still-current/stale due facts with action, reason, capability, and evidence", () => {
    addFact("stale", "Normal sourced fact", { provenanceJson: "{}" });
    const result = bucket("stale");
    expect(result.bucket).toBe("stale-candidate");
    expect(result.reason).toBe("stale_due_for_reverification");
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("classifies explicit TTL expiry only when validity metadata exists", () => {
    addFact("expired", "Temporary flag", {
      validUntil: 1,
      provenanceJson: "{}",
    });
    addFact("old-no-ttl", "Old without TTL", { provenanceJson: "{}" });
    expect(bucket("expired").bucket).toBe("expired-ttl-candidate");
    expect(bucket("old-no-ttl").bucket).not.toBe("expired-ttl-candidate");
  });

  it("supersession requires an explicit newer fact id and same scope", () => {
    addFact("old", "Path is /old", { provenanceJson: "{}" });
    addFact("new", "Path is /new", {
      supersedesId: "old",
      provenanceJson: "{}",
    });
    expect(bucket("old")).toMatchObject({
      bucket: "superseded-candidate",
      reason: "newer_verified_fact_exists",
    });

    addFact("other-old", "Mode is A", {
      provenanceJson: "{}",
      scope: "user",
      scopeTarget: "u1",
    });
    addFact("other-new", "Mode is B", {
      supersedesId: "other-old",
      provenanceJson: "{}",
      scope: "user",
      scopeTarget: "u2",
    });
    expect(bucket("other-old").bucket).not.toBe("superseded-candidate");
  });

  it("contradiction requires concrete same-scope structured conflicting evidence, not semantic relatedness", () => {
    addFact("endpoint-a", "Endpoint is A", {
      entity: "service",
      key: "endpoint",
      value: "A",
      provenanceJson: "{}",
    });
    addFact("endpoint-b", "Endpoint is B", {
      entity: "service",
      key: "endpoint",
      value: "B",
      provenanceJson: "{}",
    });
    const contradicted = bucket("endpoint-a");
    expect(contradicted.bucket).toBe("contradicted-candidate");
    expect(contradicted.evidence[0].fields).toMatchObject({
      subject: "service",
      claimType: "endpoint",
      conflictingValue: "B",
      sourceId: "endpoint-b",
    });

    addFact("related-a", "Service has an endpoint", {
      entity: "related-service",
      key: "endpoint",
      value: "A",
      provenanceJson: "{}",
    });
    addFact("related-b", "Service has a dashboard", {
      entity: "related-service",
      key: "dashboard",
      value: "B",
      provenanceJson: "{}",
    });
    expect(bucket("related-a").bucket).not.toBe("contradicted-candidate");
  });

  it("scope isolation prevents cross-scope contradiction and duplicate classification", () => {
    addFact("scoped-a", "Theme is dark", {
      entity: "prefs",
      key: "theme",
      value: "dark",
      scope: "user",
      scopeTarget: "u1",
      provenanceJson: "{}",
    });
    addFact("scoped-b", "Theme is light", {
      entity: "prefs",
      key: "theme",
      value: "light",
      scope: "user",
      scopeTarget: "u2",
      provenanceJson: "{}",
    });
    addFact("dup-a", "Same harmless fact", {
      scope: "user",
      scopeTarget: "u1",
      provenanceJson: "{}",
    });
    addFact("dup-b", "Same harmless fact", {
      scope: "user",
      scopeTarget: "u2",
      provenanceJson: "{}",
    });
    expect(bucket("scoped-a").bucket).not.toBe("contradicted-candidate");
    expect(bucket("dup-a").bucket).not.toBe("duplicate-candidate");
  });

  it("ignores stale verified versions when finding duplicate candidates", () => {
    addFact("versioned", "Original shared text", { provenanceJson: "{}" });
    const originalVerified = verificationStore.getVerified("versioned");
    expect(originalVerified).not.toBeNull();
    verificationStore.update(originalVerified?.id ?? "", "Changed shared text", "user");
    factsDb.getRawDb().prepare("UPDATE facts SET text = ? WHERE id = ?").run("Changed shared text", "versioned");
    addFact("candidate", "Original shared text", { provenanceJson: "{}" });

    expect(bucket("candidate").bucket).not.toBe("duplicate-candidate");
  });

  it("excludes checksum-invalid rows from contradiction evidence", () => {
    addFact("valid-claim", "Endpoint is A", {
      entity: "checksum-service",
      key: "endpoint",
      value: "A",
      provenanceJson: "{}",
    });
    addFact("invalid-evidence", "Endpoint is B", {
      entity: "checksum-service",
      key: "endpoint",
      value: "B",
      provenanceJson: "{}",
    });
    factsDb
      .getRawDb()
      .prepare("UPDATE verified_facts SET canonical_text = ? WHERE fact_id = ?")
      .run("tampered", "invalid-evidence");

    expect(bucket("valid-claim").bucket).not.toBe("contradicted-candidate");
  });

  it("classifies weak provenance, duplicate candidates, sensitive facts, and failed review", () => {
    addFact("weak", "No provenance here", { source: "unknown" });
    addFact("dup-1", "Duplicate durable truth", { provenanceJson: "{}" });
    addFact("dup-2", "Duplicate durable truth", { provenanceJson: "{}" });
    addFact("secret", "The API token is stored in vault", {
      provenanceJson: "{}",
    });
    addFact("missing", "Missing row", { provenanceJson: "{}" });
    factsDb.getRawDb().exec("PRAGMA foreign_keys = OFF");
    factsDb.getRawDb().prepare("DELETE FROM facts WHERE id = ?").run("missing");
    factsDb.getRawDb().exec("PRAGMA foreign_keys = ON");

    expect(bucket("weak").bucket).toBe("missing-or-weak-provenance");
    expect(bucket("dup-1").bucket).toBe("duplicate-candidate");
    expect(bucket("secret")).toMatchObject({
      bucket: "sensitive-needs-human",
      humanReviewRequired: true,
    });
    expect(bucket("missing").bucket).toBe("failed-review");
  });

  it("sensitive credentials/security/privacy/persona facts require human review and no mutation", async () => {
    addFact("security", "SSH runbook uses password vault procedure", {
      provenanceJson: "{}",
    });
    const result = await runVerifiedFactTriage(factsDb, {
      mode: "apply",
      policy: "apply-obvious",
      store: pendingStore,
    });
    expect(result.items[0]).toMatchObject({
      bucket: "sensitive-needs-human",
      humanReviewRequired: true,
      applied: false,
    });
    expect(factsDb.getById("security")?.text).toBe("SSH runbook uses password vault procedure");
  });

  it("preserves provenance and stores audit/reason/evidence for skipped or failed items", async () => {
    addFact("prov", "No provenance missing fact", {
      provenanceJson: JSON.stringify({ sourceFactIds: ["src-1"] }),
    });
    const before = factsDb.getById("prov")?.provenanceJson;
    const result = await runVerifiedFactTriage(factsDb, {
      mode: "apply",
      policy: "classify",
      store: pendingStore,
    });
    expect(factsDb.getById("prov")?.provenanceJson).toBe(before);
    const decision = pendingStore.listDecisions({ queue: "verified" })[0];
    expect(decision.audit?.summary?.metadata).toBeTruthy();
    expect(decision.evidence.length).toBeGreaterThan(0);
    expect(result.items[0].reason).toBeTruthy();
  });
});

describe("verified fact triage idempotency and parent integration", () => {
  it("uses the stored cursor when listing apply candidates", async () => {
    addFact("first-cursor", "First cursor fact", { provenanceJson: "{}" });
    addFact("second-cursor", "Second cursor fact", { provenanceJson: "{}" });
    factsDb
      .getRawDb()
      .prepare("UPDATE verified_facts SET next_verification = ? WHERE fact_id = ?")
      .run("2000-01-01T00:00:00.000Z", "first-cursor");
    factsDb
      .getRawDb()
      .prepare("UPDATE verified_facts SET next_verification = ? WHERE fact_id = ?")
      .run("2000-01-02T00:00:00.000Z", "second-cursor");

    await runVerifiedFactTriage(factsDb, {
      mode: "apply",
      policy: "classify",
      max: 1,
      store: pendingStore,
    });
    expect(pendingStore.getCursor("verified", "classify")?.cursor).toBe("2000-01-01T00:00:00.000Z");

    const secondRun = await runVerifiedFactTriage(factsDb, {
      mode: "apply",
      policy: "classify",
      max: 10,
      store: pendingStore,
    });

    expect(secondRun.items.map((item) => item.factId)).toEqual(["second-cursor"]);
  });

  it("uses list-time due context when matching same-timestamp cursor hashes", async () => {
    const firstRunNowMs = Date.parse("2026-05-12T00:00:00.000Z");
    const secondRunNowMs = Date.parse("2026-05-12T00:02:00.000Z");
    addFact("same-a", "Same timestamp A", { provenanceJson: "{}", due: false });
    addFact("same-b", "Same timestamp B", { provenanceJson: "{}", due: false });
    factsDb
      .getRawDb()
      .prepare("UPDATE verified_facts SET verified_at = ?, next_verification = ? WHERE fact_id IN (?, ?)")
      .run("2000-01-01T00:00:00.000Z", "2026-05-12T00:01:00.000Z", "same-a", "same-b");

    const firstRun = await runVerifiedFactTriage(factsDb, {
      mode: "apply",
      policy: "classify",
      max: 1,
      nowMs: firstRunNowMs,
      store: pendingStore,
    });
    expect(firstRun.items).toHaveLength(1);
    const firstFactId = firstRun.items[0]?.factId;
    expect(["same-a", "same-b"]).toContain(firstFactId);
    expect(firstRun.items[0]?.reason).toBe("stale_due_for_reverification");
    expect(pendingStore.getCursor("verified", "classify")?.cursor).toBe("2026-05-12T00:01:00.000Z");

    const secondRun = await runVerifiedFactTriage(factsDb, {
      mode: "apply",
      policy: "classify",
      max: 1,
      nowMs: secondRunNowMs,
      store: pendingStore,
    });

    expect(secondRun.items).toHaveLength(1);
    expect(["same-a", "same-b"]).toContain(secondRun.items[0]?.factId);
    expect(secondRun.items[0]?.factId).not.toBe(firstFactId);
    expect(secondRun.items[0]?.reason).toBe("stale_due_for_reverification");
  });

  it("re-running apply is idempotent and changed content/hash creates a new decision", async () => {
    addFact("idem", "Idempotent sourced fact", { provenanceJson: "{}" });
    await runVerifiedFactTriage(factsDb, {
      mode: "apply",
      policy: "classify",
      store: pendingStore,
    });
    await runVerifiedFactTriage(factsDb, {
      mode: "apply",
      policy: "classify",
      store: pendingStore,
    });
    expect(pendingStore.listDecisions({ queue: "verified" })).toHaveLength(1);
    factsDb.getRawDb().prepare("UPDATE facts SET text = ? WHERE id = ?").run("Idempotent sourced fact changed", "idem");
    const vf = verificationStore.getVerified("idem");
    expect(vf).not.toBeNull();
    factsDb
      .getRawDb()
      .prepare("UPDATE verified_facts SET canonical_text = ?, checksum = ? WHERE id = ?")
      .run("Idempotent sourced fact changed", checksum("Idempotent sourced fact changed"), vf?.id ?? "");
    await runVerifiedFactTriage(factsDb, {
      mode: "apply",
      policy: "classify",
      store: pendingStore,
    });
    expect(pendingStore.listDecisions({ queue: "verified", itemId: vf?.id ?? "" })).toHaveLength(1);
  });

  it("has cursor/hash stale-decision guard before apply", async () => {
    addFact("stale-hash", "Before", { provenanceJson: "{}" });
    const item = oneItem("stale-hash");
    const adapter = createVerifiedFactTriageAdapter({
      factsDb,
      max: 10,
      policy: "classify",
    });
    const originalListPending = adapter.listPending;
    let mutated = false;
    adapter.listPending = async (cursor) => {
      const items = await originalListPending(cursor);
      if (!mutated) {
        mutated = true;
        factsDb.getRawDb().prepare("UPDATE facts SET text = ? WHERE id = ?").run("After", "stale-hash");
        const vf = verificationStore.getVerified("stale-hash");
        factsDb
          .getRawDb()
          .prepare("UPDATE verified_facts SET canonical_text = ?, checksum = ? WHERE id = ?")
          .run("After", checksum("After"), vf?.id ?? "");
      }
      return items;
    };
    const snapshotHash = computePendingInputHash({
      queue: item.queue,
      id: item.id,
      payload: item.payload,
      policy: "classify",
      policyVersion: item.policyVersion,
    });
    expect(snapshotHash).toBe(item.inputHash);

    const result = await runVerifiedFactTriageWithAdapter(factsDb, adapter, {
      mode: "apply",
      policy: "classify",
      store: pendingStore,
    });

    expect(result.items[0]?.action).toBe("failed-validation");
    expect(result.items[0]?.reasonCode).toBe("input-hash-mismatch");
    expect(pendingStore.listDecisions({ queue: "verified" })[0]?.reasonCode).toBe("input-hash-mismatch");
  });

  it("releases the apply lock when locked decisioning throws", async () => {
    addFact("throws-under-lock", "Throwing sourced fact", { provenanceJson: "{}" });
    const adapter = createVerifiedFactTriageAdapter({
      factsDb,
      max: 10,
      policy: "classify",
    });
    adapter.decide = async () => {
      throw new Error("synthetic decide failure");
    };
    const originalReleaseLock = pendingStore.releaseLock.bind(pendingStore);
    let releaseCalls = 0;
    pendingStore.releaseLock = (input) => {
      releaseCalls += 1;
      return originalReleaseLock(input);
    };

    await expect(
      runVerifiedFactTriageWithAdapter(factsDb, adapter, {
        mode: "apply",
        policy: "classify",
        store: pendingStore,
      }),
    ).rejects.toThrow("synthetic decide failure");

    expect(releaseCalls).toBe(1);
  });

  it("re-evaluates triage decision under lock before persisting", async () => {
    addFact("target", "Endpoint A", {
      entity: "svc",
      key: "endpoint",
      value: "A",
      provenanceJson: "{}",
    });
    const originalAcquireLock = pendingStore.acquireLock.bind(pendingStore);
    let mutated = false;
    pendingStore.acquireLock = (input) => {
      if (!mutated) {
        mutated = true;
        addFact("target-conflict", "Endpoint B", {
          entity: "svc",
          key: "endpoint",
          value: "B",
          provenanceJson: "{}",
        });
      }
      return originalAcquireLock(input);
    };

    const result = await runVerifiedFactTriage(factsDb, {
      mode: "apply",
      policy: "classify",
      store: pendingStore,
    });

    expect(result.items[0]).toMatchObject({
      factId: "target",
      action: "deferred-for-human",
      reason: "contradicting_verified_fact_exists",
      applied: false,
    });
    expect(pendingStore.listDecisions({ queue: "verified" })[0]).toMatchObject({
      action: "deferred-for-human",
      reasonCode: "human-review-required",
    });
  });

  it("standalone verified triage and parent adapter route produce equivalent decisions", async () => {
    addFact("equiv", "Equivalence sourced fact", { provenanceJson: "{}" });
    const nowMs = Date.parse("2026-05-12T00:00:00Z");
    const adapter = createVerifiedFactTriageAdapter({
      factsDb,
      max: 10,
      policy: "classify",
      nowMs,
    });
    const item = listVerifiedFactTriageItems(factsDb.getRawDb(), {
      max: 10,
      nowMs,
      policy: "classify",
    }).find((candidate) => candidate.payload.verified.factId === "equiv");
    if (!item) throw new Error("missing equivalence item");
    await expectStandaloneAndParentDecisionsEquivalent({
      standalone: (fixture, context) =>
        adapter.decide(fixture as VerifiedFactTriageItem, {
          ...context,
          inputHash: fixture.inputHash,
        }),
      parent: (_fixture, context) => {
        const refreshed = listVerifiedFactTriageItems(factsDb.getRawDb(), {
          max: 10,
          nowMs,
          policy: assertVerifiedTriagePolicy(context.policy),
        }).find((candidate) => candidate.id === item.id);
        if (!refreshed) throw new Error("missing refreshed verified triage item");
        return adapter.decide(refreshed as VerifiedFactTriageItem, {
          ...context,
          inputHash: refreshed.inputHash,
        });
      },
      fixtures: [
        {
          item,
          policy: "classify",
          policyVersion: VERIFIED_TRIAGE_POLICY_VERSION,
        },
      ],
    });
  });
});

function checksum(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
