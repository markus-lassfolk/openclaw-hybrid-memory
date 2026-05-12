import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTOPILOT_ACTIONS,
  AUTOPILOT_CAPABILITY_CLASSES,
  AUTOPILOT_REASON_CODES,
  PENDING_QUEUES,
  PendingAutopilotStore,
  type PendingDecision,
  migratePendingAutopilotTables,
  type PendingItem,
  type PendingQueueAdapter,
  assertKnownEnum,
  computePendingInputHash,
  canonicalJson,
  createStableRunSummary,
  redactAutopilotValue,
  stableRunSummaryJson,
} from "../services/pending-autopilot/index.js";
import { expectStandaloneAndParentDecisionsEquivalent } from "./helpers/pending-autopilot-equivalence.js";

let tmpDir: string;
let store: PendingAutopilotStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pending-autopilot-"));
  store = new PendingAutopilotStore(join(tmpDir, "pending.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function decision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    queue: "persona",
    itemId: "item-1",
    inputHash: "hash-1",
    policy: "default",
    policyVersion: "policy-v1",
    mode: "apply",
    action: "classified",
    reasonCode: "policy-threshold-not-met",
    actionClass: "record-review",
    capabilityClass: "record-review-metadata",
    confidence: 0.7,
    humanReviewRequired: false,
    evidence: [{ type: "fixture", id: "ev-1", summary: "safe" }],
    actor: { type: "test", id: "unit" },
    runId: "run-1",
    jobId: "job-1",
    ...overrides,
  };
}

describe("pending-autopilot shared contracts", () => {
  it("snapshots enum contracts and rejects unknown action/reason/capability values", () => {
    expect({
      queues: PENDING_QUEUES,
      actions: AUTOPILOT_ACTIONS,
      reasons: AUTOPILOT_REASON_CODES,
      capabilities: AUTOPILOT_CAPABILITY_CLASSES,
    }).toMatchInlineSnapshot(`
      {
        "actions": [
          "reported",
          "classified",
          "applied",
          "rejected",
          "promoted-to-draft",
          "deferred-for-human",
          "failed-validation",
          "failed-audit",
          "unknown-decision",
          "skipped-by-policy",
        ],
        "capabilities": [
          "read-only",
          "dry-run",
          "record-review-metadata",
          "safe-state-transition",
          "write-draft-artifact",
          "apply-low-risk-change",
          "enable-behaviour",
          "trust-changing-action",
          "external-side-effect",
          "destructive-action",
        ],
        "queues": [
          "persona",
          "procedures",
          "verified",
          "tools",
          "crystallization",
        ],
        "reasons": [
          "already-processed",
          "audit-write-failed",
          "capability-not-allowed",
          "dry-run",
          "duplicate-input",
          "human-review-required",
          "input-hash-mismatch",
          "invalid-item",
          "lock-conflict",
          "lock-expired",
          "lock-missing",
          "lock-owner-mismatch",
          "policy-denied",
          "policy-report-only",
          "policy-requires-human",
          "policy-threshold-not-met",
          "duplicate-applied-proposal",
          "duplicate-pending-proposal",
          "stale-target-context",
          "low-confidence",
          "non-actionable",
          "self-contradictory",
          "secret-or-private-data-risk",
          "identity-boundary-change",
          "privacy-boundary-change",
          "security-boundary-change",
          "user-preference-change-requires-approval",
          "conflicts-with-edict",
          "conflicts-with-existing-guidance",
          "large-or-broad-diff",
          "missing-evidence",
          "validation-failed",
          "safe-low-risk-localized-change",
          "schema-validation-failed",
          "unknown-decision",
          "unknown-queue",
        ],
      }
    `);
    expect(() => assertKnownEnum("action", "invented-action")).toThrow(/Unknown pending-autopilot action/);
    expect(() => assertKnownEnum("reasonCode", "mystery")).toThrow(/Unknown pending-autopilot reasonCode/);
    expect(() => assertKnownEnum("capabilityClass", "root-shell")).toThrow(/Unknown pending-autopilot capabilityClass/);
  });
});

describe("pending-autopilot durable state invariants", () => {
  it("dry-run contract writes no durable foundation tables, including run rows", () => {
    const before = store.tableCounts();
    const dry = decision({
      mode: "dry-run",
      reasonCode: "dry-run",
      capabilityClass: "dry-run",
      actionClass: "preview",
    });
    store.createRun({
      runId: dry.runId,
      mode: "dry-run",
      policy: dry.policy,
      policyVersion: dry.policyVersion,
      inputHash: dry.inputHash,
      queues: ["persona"],
    });
    store.finishRun(
      dry.runId,
      createStableRunSummary({
        runId: dry.runId,
        mode: "dry-run",
        policy: dry.policy,
        policyVersion: dry.policyVersion,
        queues: ["persona"],
        startedAt: 1,
        decisions: [dry],
      }),
    );
    expect(store.recordDecision(dry).inserted).toBe(false);
    expect(
      store.acquireLock({
        queue: "persona",
        itemId: "item-1",
        inputHash: "hash-1",
        owner: "test",
        ttlSeconds: 60,
        mode: "dry-run",
      }),
    ).toBe(false);
    expect(
      store.releaseLock({ queue: "persona", itemId: "item-1", inputHash: "hash-1", owner: "test", mode: "dry-run" }),
    ).toBe(false);
    expect(store.advanceCursorIfSafe(dry, "cursor-2")).toBe(false);
    expect(
      store.mutateWithLockAndAudit({
        decision: dry,
        owner: "test",
        actualInputHash: "hash-1",
        audit: () => {},
        mutate: () => {
          throw new Error("must not mutate");
        },
      }),
    ).toBe(false);
    expect(
      store.mutateWithInputHash({
        queue: "persona",
        itemId: "item-1",
        expectedInputHash: "hash-1",
        actualInputHash: "hash-1",
        mode: "dry-run",
        mutate: () => {
          throw new Error("must not mutate");
        },
      }),
    ).toBe(false);
    expect(store.tableCounts()).toEqual(before);
  });

  it("redacts secrets/private data before persisted summaries and audit output", () => {
    const input = decision({
      summary: {
        title: "token test",
        body: [
          "apiKey=sk-secret123456789 and password=hunter2",
          "classic github token ghp_123456789abcdef123456789abcdef123456",
          "fine grained github token github_pat_abcdefghijklmnopqrstuvwxyz1234567890",
          "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
        ].join("\n"),
      },
      audit: {
        queue: "persona",
        itemId: "item-1",
        inputHash: "hash-1",
        policy: "default",
        policyVersion: "policy-v1",
        action: "classified",
        reasonCode: "policy-denied",
        capabilityClass: "record-review-metadata",
        humanReviewRequired: false,
        evidence: [{ type: "secret", summary: "Bearer abcdefghijklmnop" }],
        actor: { type: "test", id: "unit" },
        runId: "run-1",
        summary: { metadata: { token: "ghp_123456789abcdef", nested: "Bearer abcdefghijklmnop" } },
      },
    });
    store.recordDecision(input);
    const persisted = store.listDecisions()[0];
    expect(JSON.stringify(persisted)).not.toContain("sk-secret");
    expect(JSON.stringify(persisted)).not.toContain("hunter2");
    expect(JSON.stringify(persisted)).not.toContain("ghp_123");
    expect(JSON.stringify(persisted)).not.toContain("github_pat_");
    expect(JSON.stringify(persisted)).not.toContain("Bearer abc");
    expect(JSON.stringify(persisted)).not.toContain("-----BEGIN PRIVATE KEY-----");
    expect(JSON.stringify(persisted)).toContain("[REDACTED]");
    expect(
      redactAutopilotValue({
        password: "abc",
        token: "github_pat_123456789abcdef",
        tokenCount: 7,
        secretary: "not-secret-key-name",
        url: "postgres://u:p@example/db",
        key: "-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----",
      }),
    ).toEqual({
      password: "[REDACTED]",
      token: "[REDACTED]",
      tokenCount: 7,
      secretary: "not-secret-key-name",
      url: "[REDACTED]",
      key: "[REDACTED]",
    });
  });

  it("input hashes change for non-secret field updates and non-plain objects", () => {
    expect(computePendingInputHash({ tokenCount: 1 })).not.toBe(computePendingInputHash({ tokenCount: 2 }));
    expect(computePendingInputHash({ at: new Date("2026-01-01T00:00:00Z") })).not.toBe(
      computePendingInputHash({ at: new Date("2026-01-02T00:00:00Z") }),
    );
    expect(computePendingInputHash(new URL("https://example.com/a"))).not.toBe(
      computePendingInputHash(new URL("https://example.com/b")),
    );
  });

  it("deterministically serializes non-JSON top-level input hash values", () => {
    const namedFunction = function pendingFixture() {
      return undefined;
    };
    expect(canonicalJson(undefined)).toBe('{"__pendingAutopilotType":"undefined"}');
    expect(() => computePendingInputHash(undefined)).not.toThrow();
    expect(() => computePendingInputHash(namedFunction)).not.toThrow();
    expect(() => computePendingInputHash(Symbol("pending"))).not.toThrow();
    expect(() => computePendingInputHash(123n)).not.toThrow();
    expect(computePendingInputHash(undefined)).toBe(computePendingInputHash(undefined));
    expect(computePendingInputHash(namedFunction)).toBe(computePendingInputHash(namedFunction));
    expect(computePendingInputHash(Symbol("pending"))).toBe(computePendingInputHash(Symbol("pending")));
    expect(computePendingInputHash(Symbol("pending"))).not.toBe(computePendingInputHash(Symbol("other")));
    expect(computePendingInputHash(123n)).not.toBe(computePendingInputHash(124n));
  });

  it("preserves Map and Set identity through redaction for deterministic canonicalization", () => {
    const redactedMap = redactAutopilotValue(
      new Map<unknown, unknown>([
        ["token", "github_pat_123456789abcdef"],
        [{ z: 1 }, new Set(["b", "a"])],
      ]),
    );
    const redactedSet = redactAutopilotValue(new Set<unknown>(["b", "a", "Bearer abcdefghijklmnop"]));

    expect(redactedMap).toBeInstanceOf(Map);
    expect(redactedSet).toBeInstanceOf(Set);
    expect(canonicalJson(new Set(["b", "a"]))).toBe(canonicalJson(new Set(["a", "b"])));
    expect(
      canonicalJson(
        new Map([
          ["b", 2],
          ["a", 1],
        ]),
      ),
    ).toBe(
      canonicalJson(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      ),
    );
    expect(canonicalJson(redactedMap)).toContain('"__pendingAutopilotType":"Map"');
    expect(canonicalJson(redactedSet)).toContain('"__pendingAutopilotType":"Set"');
    expect(canonicalJson(redactedMap)).toContain("[REDACTED]");
    expect(canonicalJson(redactedSet)).toContain("[REDACTED]");
  });

  it("requires active lock ownership and transactional audit before mutation", () => {
    let mutated = false;
    const fresh = decision({ inputHash: "hash-fresh" });
    expect(
      store.mutateWithInputHash({
        queue: "persona",
        itemId: "item-1",
        expectedInputHash: "hash-fresh",
        actualInputHash: "hash-fresh",
        mode: "apply",
        mutate: () => {
          mutated = true;
        },
      }),
    ).toBe(false);
    expect(mutated).toBe(false);
    expect(
      store.mutateWithLockAndAudit({
        decision: fresh,
        owner: "runner",
        actualInputHash: "hash-fresh",
        audit: () => {},
        mutate: () => {
          mutated = true;
        },
      }),
    ).toBe(false);
    expect(mutated).toBe(false);
    expect(
      store.acquireLock({
        queue: "persona",
        itemId: "item-1",
        inputHash: "hash-fresh",
        owner: "runner",
        ttlSeconds: 60,
        mode: "apply",
      }),
    ).toBe(true);
    expect(
      store.mutateWithLockAndAudit({
        decision: fresh,
        owner: "wrong-runner",
        actualInputHash: "hash-fresh",
        audit: () => {},
        mutate: () => {
          mutated = true;
        },
      }),
    ).toBe(false);
    expect(mutated).toBe(false);
    expect(
      store.mutateWithLockAndAudit({
        decision: fresh,
        owner: "runner",
        actualInputHash: "hash-old",
        audit: () => {},
        mutate: () => {
          mutated = true;
        },
      }),
    ).toBe(false);
    expect(mutated).toBe(false);
    expect(() =>
      store.mutateWithLockAndAudit({
        decision: fresh,
        owner: "runner",
        actualInputHash: "hash-fresh",
        audit: () => {
          throw new Error("audit unavailable");
        },
        mutate: () => {
          mutated = true;
        },
      }),
    ).toThrow(/audit unavailable/);
    expect(mutated).toBe(false);
    expect(store.listDecisions()).toHaveLength(0);
    expect(
      store.mutateWithLockAndAudit({
        decision: fresh,
        owner: "runner",
        actualInputHash: "hash-fresh",
        audit: () => {},
        mutate: () => {
          mutated = true;
        },
      }),
    ).toBe(true);
    expect(mutated).toBe(true);
    expect(store.listDecisions()).toHaveLength(1);
  });

  it("idempotently records the same queue/item/hash/policy/policy-version/action only once", () => {
    expect(store.recordDecision(decision()).inserted).toBe(true);
    expect(store.recordDecision(decision()).inserted).toBe(false);
    expect(
      store.recordDecision(
        decision({ action: "applied", capabilityClass: "apply-low-risk-change", actionClass: "low-risk-apply" }),
      ).inserted,
    ).toBe(true);
    expect(store.recordDecision(decision({ policyVersion: "policy-v2", runId: "run-2" })).inserted).toBe(true);
    expect(store.listDecisions()).toHaveLength(3);
  });

  it("migrates the decisions unique key so policy-version upgrades are reprocessed", () => {
    const db = new DatabaseSync(join(tmpDir, "legacy.db"));
    db.exec(`
      CREATE TABLE pending_autopilot_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue TEXT NOT NULL,
        item_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        policy TEXT NOT NULL DEFAULT 'default',
        policy_version TEXT NOT NULL,
        mode TEXT NOT NULL,
        action TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        action_class TEXT NOT NULL,
        capability_class TEXT NOT NULL,
        confidence REAL NOT NULL,
        human_review_required INTEGER NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        actor_json TEXT NOT NULL DEFAULT '{}',
        run_id TEXT NOT NULL,
        job_id TEXT,
        summary_json TEXT,
        audit_json TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(queue, item_id, input_hash, policy, action)
      );
    `);

    migratePendingAutopilotTables(db);

    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_autopilot_decisions'")
      .get() as { sql: string };
    expect(sql.sql).toContain("UNIQUE(queue, item_id, input_hash, policy, policy_version, action)");

    const insert = db.prepare(`
      INSERT INTO pending_autopilot_decisions
        (queue, item_id, input_hash, policy, policy_version, mode, action, reason_code, action_class, capability_class, confidence, human_review_required, evidence_json, actor_json, run_id, created_at)
      VALUES ('persona', 'item-1', 'hash-1', 'default', ?, 'apply', 'classified', 'policy-threshold-not-met', 'record-review', 'record-review-metadata', 0.7, 0, '[]', '{}', ?, ?)
    `);
    insert.run("policy-v1", "run-1", 1);
    insert.run("policy-v2", "run-2", 2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM pending_autopilot_decisions").get() as { n: number }).n).toBe(2);
    db.close();
  });

  it("does not hide human-review-required, failed-validation, failed-audit, or unknown decisions by advancing cursor", () => {
    expect(
      store.advanceCursorIfSafe(
        decision({ action: "deferred-for-human", reasonCode: "human-review-required", humanReviewRequired: true }),
        "cursor-human",
      ),
    ).toBe(false);
    expect(store.getCursor("persona")).toBeNull();
    expect(
      store.advanceCursorIfSafe(
        decision({ action: "failed-validation", reasonCode: "schema-validation-failed" }),
        "cursor-failed",
      ),
    ).toBe(false);
    expect(
      store.advanceCursorIfSafe(decision({ action: "failed-audit", reasonCode: "audit-write-failed" }), "cursor-audit"),
    ).toBe(false);
    expect(
      store.advanceCursorIfSafe(
        decision({ action: "unknown-decision", reasonCode: "unknown-decision" }),
        "cursor-unknown",
      ),
    ).toBe(false);
    expect(store.getCursor("persona")).toBeNull();
    expect(
      store.advanceCursorIfSafe(
        decision({ action: "applied", capabilityClass: "apply-low-risk-change", actionClass: "low-risk-apply" }),
        "cursor-applied",
      ),
    ).toBe(true);
    expect(store.getCursor("persona")?.cursor).toBe("cursor-applied");
  });
});

describe("pending-autopilot summaries and harness", () => {
  it("generates a stable JSON summary schema", () => {
    const summary = createStableRunSummary({
      runId: "run-1",
      mode: "apply",
      policy: "default",
      policyVersion: "policy-v1",
      queues: ["tools", "persona"],
      startedAt: 100,
      finishedAt: 110,
      decisions: [
        decision({
          queue: "tools",
          itemId: "b",
          action: "reported",
          reasonCode: "already-processed",
          capabilityClass: "read-only",
          actionClass: "observe",
        }),
        decision({
          itemId: "a",
          action: "applied",
          capabilityClass: "apply-low-risk-change",
          actionClass: "low-risk-apply",
        }),
      ],
    });
    expect(stableRunSummaryJson(summary)).toMatchInlineSnapshot(
      `"{\"decisions\":[{\"action\":\"applied\",\"capabilityClass\":\"apply-low-risk-change\",\"confidence\":0.7,\"humanReviewRequired\":false,\"inputHash\":\"hash-1\",\"itemId\":\"a\",\"policy\":\"default\",\"policyVersion\":\"policy-v1\",\"queue\":\"persona\",\"reasonCode\":\"policy-threshold-not-met\"},{\"action\":\"reported\",\"capabilityClass\":\"read-only\",\"confidence\":0.7,\"humanReviewRequired\":false,\"inputHash\":\"hash-1\",\"itemId\":\"b\",\"policy\":\"default\",\"policyVersion\":\"policy-v1\",\"queue\":\"tools\",\"reasonCode\":\"already-processed\"}],\"finishedAt\":110,\"mode\":\"apply\",\"policy\":\"default\",\"policyVersion\":\"policy-v1\",\"queues\":[\"persona\",\"tools\"],\"runId\":\"run-1\",\"startedAt\":100,\"totals\":{\"applied\":1,\"classified\":0,\"deferred-for-human\":0,\"failed-audit\":0,\"failed-validation\":0,\"promoted-to-draft\":0,\"rejected\":0,\"reported\":1,\"skipped-by-policy\":0,\"unknown-decision\":0}}\n"`,
    );
  });

  it("provides a parent/child equivalence harness primitive for distinct fake execution paths", async () => {
    const adapter: PendingQueueAdapter = {
      queue: "persona",
      listPending: () => [],
      decide: (item: PendingItem, context) =>
        decision({
          queue: item.queue,
          itemId: item.id,
          inputHash: context.inputHash,
          policy: context.policy,
          policyVersion: context.policyVersion,
          runId: context.runId,
          actor: context.actor,
          mode: context.mode,
          action: item.requiresHumanReview ? "deferred-for-human" : "classified",
          reasonCode: item.requiresHumanReview ? "human-review-required" : "policy-threshold-not-met",
          humanReviewRequired: item.requiresHumanReview === true,
        }),
    };
    const parentRunner = async (item: PendingItem, context: Parameters<typeof adapter.decide>[1]) => {
      const listed = [item];
      const match = listed.find((candidate) => candidate.id === item.id)!;
      return adapter.decide(match, context);
    };
    const payload = { title: "hello" };
    const item: PendingItem = {
      queue: "persona",
      id: "fixture-1",
      inputHash: computePendingInputHash({
        queue: "persona",
        id: "fixture-1",
        payload,
        policy: "default",
        policyVersion: "policy-v1",
      }),
      policyVersion: "policy-v1",
      capabilityClasses: ["record-review-metadata"],
      payload,
      requiresHumanReview: true,
    };
    await expectStandaloneAndParentDecisionsEquivalent({
      standalone: adapter.decide,
      parent: parentRunner,
      fixtures: [{ item, policy: "default", policyVersion: "policy-v1" }],
    });
  });
});
