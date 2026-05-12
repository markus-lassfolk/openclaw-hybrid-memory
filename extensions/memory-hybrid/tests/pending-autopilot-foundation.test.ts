import { mkdtempSync, rmSync } from "node:fs";
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
  type PendingItem,
  type PendingQueueAdapter,
  assertKnownEnum,
  computePendingInputHash,
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
          "policy-threshold-not-met",
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

  it("requires active lock ownership and transactional audit before mutation", () => {
    let mutated = false;
    const fresh = decision({ inputHash: "hash-fresh" });
    expect(
      store.mutateWithLockAndAudit({
        decision: fresh,
        owner: "runner",
        actualInputHash: "hash-fresh",
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
        mutate: () => {
          mutated = true;
        },
      }),
    ).toBe(true);
    expect(mutated).toBe(true);
    expect(store.listDecisions()).toHaveLength(1);
  });

  it("idempotently records the same queue/item/hash/policy/action only once", () => {
    expect(store.recordDecision(decision()).inserted).toBe(true);
    expect(store.recordDecision(decision()).inserted).toBe(false);
    expect(
      store.recordDecision(
        decision({ action: "applied", capabilityClass: "apply-low-risk-change", actionClass: "low-risk-apply" }),
      ).inserted,
    ).toBe(true);
    expect(store.listDecisions()).toHaveLength(2);
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
