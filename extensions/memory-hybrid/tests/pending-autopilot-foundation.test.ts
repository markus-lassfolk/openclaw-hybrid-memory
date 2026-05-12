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
    policyVersion: "policy-v1",
    mode: "apply",
    action: "classified",
    reasonCode: "policy-threshold-not-met",
    actionClass: "classify",
    capabilityClass: "classify",
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
          "skipped-by-policy",
        ],
        "capabilities": [
          "read",
          "classify",
          "write-queue",
          "write-repo",
          "write-memory",
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
          "capability-not-allowed",
          "dry-run",
          "duplicate-input",
          "human-review-required",
          "input-hash-mismatch",
          "invalid-item",
          "lock-conflict",
          "policy-denied",
          "policy-threshold-not-met",
          "schema-validation-failed",
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
  it("dry-run contract writes no durable decision/cursor/lock state", () => {
    const before = store.tableCounts();
    expect(store.recordDecision(decision({ mode: "dry-run", reasonCode: "dry-run" })).inserted).toBe(false);
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
    expect(store.advanceCursorIfSafe(decision({ mode: "dry-run" }), "cursor-2")).toBe(false);
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
        policyVersion: "policy-v1",
        action: "classified",
        reasonCode: "policy-denied",
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
        url: "postgres://u:p@example/db",
        key: "-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----",
      }),
    ).toEqual({
      password: "[REDACTED]",
      token: "[REDACTED]",
      url: "[REDACTED]",
      key: "[REDACTED]",
    });
  });

  it("lock/CAS helpers block stale input hash mutations", () => {
    let mutated = false;
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
      store.acquireLock({
        queue: "persona",
        itemId: "item-1",
        inputHash: "hash-fresh",
        owner: "runner-2",
        ttlSeconds: 60,
        mode: "apply",
      }),
    ).toBe(false);
    expect(
      store.mutateWithInputHash({
        queue: "persona",
        itemId: "item-1",
        expectedInputHash: "hash-old",
        actualInputHash: "hash-fresh",
        mode: "apply",
        mutate: () => {
          mutated = true;
        },
      }),
    ).toBe(false);
    expect(mutated).toBe(false);
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
    ).toBe(true);
    expect(mutated).toBe(true);
  });

  it("idempotently records the same queue/item/hash/policy only once", () => {
    expect(store.recordDecision(decision()).inserted).toBe(true);
    expect(store.recordDecision(decision({ action: "applied" })).inserted).toBe(false);
    expect(store.listDecisions()).toHaveLength(1);
  });

  it("does not hide human-review-required or failed-validation items by advancing cursor", () => {
    expect(
      store.advanceCursorIfSafe(
        decision({ action: "deferred-for-human", reasonCode: "human-review-required" }),
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
    expect(store.getCursor("persona")).toBeNull();
    expect(store.advanceCursorIfSafe(decision({ action: "applied" }), "cursor-applied")).toBe(true);
    expect(store.getCursor("persona")?.cursor).toBe("cursor-applied");
  });
});

describe("pending-autopilot summaries and harness", () => {
  it("generates a stable JSON summary schema", () => {
    const summary = createStableRunSummary({
      runId: "run-1",
      mode: "apply",
      policyVersion: "policy-v1",
      queues: ["tools", "persona"],
      startedAt: 100,
      finishedAt: 110,
      decisions: [
        decision({ queue: "tools", itemId: "b", action: "reported", reasonCode: "already-processed" }),
        decision({ itemId: "a", action: "applied" }),
      ],
    });
    expect(stableRunSummaryJson(summary)).toMatchInlineSnapshot(
      `"{\"decisions\":[{\"action\":\"applied\",\"inputHash\":\"hash-1\",\"itemId\":\"a\",\"policyVersion\":\"policy-v1\",\"queue\":\"persona\",\"reasonCode\":\"policy-threshold-not-met\"},{\"action\":\"reported\",\"inputHash\":\"hash-1\",\"itemId\":\"b\",\"policyVersion\":\"policy-v1\",\"queue\":\"tools\",\"reasonCode\":\"already-processed\"}],\"finishedAt\":110,\"mode\":\"apply\",\"policyVersion\":\"policy-v1\",\"queues\":[\"persona\",\"tools\"],\"runId\":\"run-1\",\"startedAt\":100,\"totals\":{\"applied\":1,\"classified\":0,\"deferred-for-human\":0,\"failed-validation\":0,\"promoted-to-draft\":0,\"rejected\":0,\"reported\":1,\"skipped-by-policy\":0}}\n"`,
    );
  });

  it("provides a parent/child equivalence harness primitive for fake adapters", async () => {
    const adapter: PendingQueueAdapter = {
      queue: "persona",
      listPending: () => [],
      decide: (item: PendingItem, context) =>
        decision({
          queue: item.queue,
          itemId: item.id,
          inputHash: context.inputHash,
          policyVersion: context.policyVersion,
          runId: context.runId,
          mode: context.mode,
          action: item.requiresHumanReview ? "deferred-for-human" : "classified",
          reasonCode: item.requiresHumanReview ? "human-review-required" : "policy-threshold-not-met",
        }),
    };
    const payload = { title: "hello" };
    const item: PendingItem = {
      queue: "persona",
      id: "fixture-1",
      inputHash: computePendingInputHash({
        queue: "persona",
        id: "fixture-1",
        payload,
        policyVersion: "policy-v1",
      }),
      policyVersion: "policy-v1",
      capabilityClasses: ["classify"],
      payload,
      requiresHumanReview: true,
    };
    await expectStandaloneAndParentDecisionsEquivalent(adapter, [{ item, policyVersion: "policy-v1" }]);
  });
});
