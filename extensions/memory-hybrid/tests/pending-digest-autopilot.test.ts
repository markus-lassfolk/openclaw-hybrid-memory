import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import type { ProcedureTriageReport } from "../backends/facts-db/procedures.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageDigest } from "../cli/commands/manage/register-digest.js";
import { type HybridMemoryConfig, hybridConfigSchema } from "../config.js";
import {
  PendingAutopilotStore,
  type PendingItem,
  computePendingInputHash,
} from "../services/pending-autopilot/index.js";
import {
  PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
  type PendingDigestFactsDb,
  createDefaultPendingDigestAdapters,
  decideReadOnlyItem,
  runPendingDigestAutopilot,
} from "../services/pending-digest-autopilot.js";
import { pendingStorePaths } from "../services/pending-review-digest.js";
import { expectStandaloneAndParentDecisionsEquivalent } from "./helpers/pending-autopilot-equivalence.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pending-digest-autopilot-"));
  dirs.push(dir);
  return dir;
}

function configFor(sqlitePath: string): HybridMemoryConfig {
  return hybridConfigSchema.parse({
    embedding: { apiKey: "sk-test-embed-key-that-is-long-enough", model: "text-embedding-3-small" },
    sqlitePath,
    lanceDbPath: join(dirname(sqlitePath), "lancedb"),
    credentials: { enabled: false },
    wal: { enabled: false },
    personaProposals: { enabled: true },
    verification: { enabled: false },
    provenance: { enabled: false },
    nightlyCycle: { enabled: false },
  });
}

function factsDb(): PendingDigestFactsDb {
  return {
    proceduresCount: () => 2,
    proceduresValidatedCount: () => 2,
    proceduresPromotedCount: () => 0,
    countVerifiedFacts: () => 2,
    proceduresValidatedSince: () => 1,
    triageProcedures: ({ limit = 10_000 } = {}): ProcedureTriageReport => ({
      rows: [
        {
          id: "proc-1",
          title: "Review repeatable procedure",
          validatedAt: 1,
          promotionBlockReason: "awaiting_approval" as const,
          lastRecall: 1,
          successCount: 5,
          confidence: 0.9,
          skillPath: null,
        },
        {
          id: "proc-2",
          title: "Missing recipe anchor",
          validatedAt: 1,
          promotionBlockReason: "missing_anchor" as const,
          lastRecall: 1,
          successCount: 3,
          confidence: 0.6,
          skillPath: null,
        },
      ].slice(0, limit),
      summary: {
        total: 2,
        byReason: { awaiting_approval: 1, missing_anchor: 1, unknown: 0, duplicate_skill: 0, low_recall: 0 },
        topReason: "awaiting_approval",
      },
    }),
  };
}

function seedQueues(cfg: HybridMemoryConfig): void {
  const paths = pendingStorePaths(cfg.sqlitePath);
  const persona = new ProposalsDB(paths.proposals);
  const tools = new ToolProposalStore(paths.toolProposals);
  const crystal = new CrystallizationStore(paths.crystallization);
  persona.create({
    targetFile: "SOUL.md",
    title: "Change identity guidance",
    observation: "Sensitive persona change.",
    suggestedChange: "Rewrite identity.",
    confidence: 0.91,
    evidenceSessions: ["session-a"],
  });
  tools.create({
    name: "safe_reporter",
    description: "Draft read-only reports",
    parameters: "{}",
    rationale: "Useful reporting helper",
    sourcePatterns: "[]",
    implementationHint: "No external writes",
  });
  crystal.create({
    patternId: "pattern-1",
    skillName: "review-backlog",
    skillContent: "# Skill",
    patternSnapshot: "{}",
  });
  persona.close();
  tools.close();
  crystal.close();
}

describe("pending digest autopilot parent (#1326)", () => {
  it("defaults to dry-run, inspects live pending queues, emits stable structured JSON, and writes no durable state", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    seedQueues(cfg);
    const stateDb = join(dir, "autopilot.db");

    const result = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      stateDbPath: stateDb,
      runId: "run-dry",
      now: new Date("2026-05-12T00:00:00.000Z"),
    });

    expect(result.mode).toBe("dry-run");
    expect(result.applyBehavior).toBe("non-mutating-dry-run");
    expect(result.digestContext).toMatchObject({
      persona: 1,
      procedures: 2,
      tools: 1,
      crystallization: 1,
      verified: 2,
    });
    expect(result.counts.inspected).toBe(7);
    expect(result.queues.persona.decisions[0]).toMatchObject({
      action: "deferred-for-human",
      reasonCode: "human-review-required",
    });
    expect(result.queues.tools.decisions[0]).toMatchObject({ action: "classified", reasonCode: "dry-run" });
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      schemaVersion: 1,
      runId: "run-dry",
      policies: { persona: "cautious", procedures: "auto-safe", verified: "classify", tools: "classify" },
      counts: { inspected: 7, applied: 0 },
    });

    const store = new PendingAutopilotStore(stateDb);
    expect(store.tableCounts()).toEqual({
      pending_autopilot_runs: 0,
      pending_autopilot_decisions: 0,
      pending_autopilot_cursors: 0,
      pending_autopilot_locks: 0,
    });
    store.close();
  });

  it("apply mode records only foundation decisions and remains idempotent without queue mutations", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    seedQueues(cfg);
    const stateDb = join(dir, "autopilot.db");

    const first = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      stateDbPath: stateDb,
      mode: "apply",
      runId: "run-apply-1",
    });
    const second = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      stateDbPath: stateDb,
      mode: "apply",
      runId: "run-apply-2",
    });

    expect(first.applyBehavior).toBe("record-decisions-only");
    expect(second.counts).toEqual(first.counts);
    const paths = pendingStorePaths(cfg.sqlitePath);
    const persona = new ProposalsDB(paths.proposals);
    expect(persona.list({ status: "pending" })).toHaveLength(1);
    persona.close();
    const store = new PendingAutopilotStore(stateDb);
    expect(store.listDecisions()).toHaveLength(7);
    expect(store.tableCounts().pending_autopilot_runs).toBe(2);
    expect(store.tableCounts().pending_autopilot_locks).toBe(0);
    store.close();
  });

  it("supports disabled per-queue policies with stable skipped reason codes and max batch sizes", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    seedQueues(cfg);
    const result = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      runId: "run-disabled",
      policies: { tools: "disabled", crystallization: "report-only" },
      max: { procedures: 1, verified: 1 },
    });

    expect(result.queues.tools).toMatchObject({ skipped: true, skipReason: "queue-disabled-by-policy", inspected: 0 });
    expect(result.queues.tools.decisions[0]).toMatchObject({
      action: "skipped-by-policy",
      reasonCode: "policy-denied",
    });
    expect(result.queues.procedures.inspected).toBe(1);
    expect(result.queues.verified.inspected).toBe(1);
    expect(result.queues.crystallization.decisions[0]).toMatchObject({
      action: "reported",
      reasonCode: "policy-denied",
    });
  });

  it("captures adapter/list failures as visible failed-validation decisions", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const result = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      runId: "run-failure",
      adapters: {
        tools: {
          queue: "tools",
          listPending: () => {
            throw new Error("backend down");
          },
          decide: decideReadOnlyItem,
        },
      },
    });

    expect(result.queues.tools).toMatchObject({ skipped: true, skipReason: "inventory-failed" });
    expect(result.queues.tools.decisions[0]).toMatchObject({
      action: "failed-validation",
      reasonCode: "schema-validation-failed",
      humanReviewRequired: true,
    });
    expect(result.humanSummary).toContain("failed validation 1");
  });

  it("parent route delegates to the same adapter decision path as standalone child route", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    seedQueues(cfg);
    const adapters = createDefaultPendingDigestAdapters({ cfg, factsDb: factsDb() });
    const listed = (await adapters.persona.listPending(null)) as PendingItem[];
    const fixture = listed[0];

    await expectStandaloneAndParentDecisionsEquivalent({
      standalone: adapters.persona.decide,
      parent: async (item, context) => {
        const parentListed = (await adapters.persona.listPending(null)) as PendingItem[];
        const matched = parentListed.find((candidate) => candidate.id === item.id);
        if (!matched) throw new Error("fixture missing from parent inventory");
        return adapters.persona.decide(matched, context);
      },
      fixtures: [{ item: fixture, policy: "default", policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION }],
    });
  });

  it("registers digest autopilot CLI and emits JSON helpfully", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    seedQueues(cfg);
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerManageDigest(program as never, { cfg, factsDb: factsDb() } as ManageBindings);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["digest", "autopilot", "--dry-run", "--json", "--max-verified", "1"], { from: "user" });

    const json = out.mock.calls.map((c) => String(c[0])).join("");
    expect(JSON.parse(json)).toMatchObject({
      mode: "dry-run",
      counts: { applied: 0 },
      queues: { verified: { inspected: 1 } },
    });
  });

  it("uses the #1334 harness input hash contract for parent fixture decisions", () => {
    const payload = { source: "fixture", title: "Stable item" };
    const item = {
      queue: "tools" as const,
      id: "tool-1",
      inputHash: computePendingInputHash({
        queue: "tools",
        id: "tool-1",
        payload,
        policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
      }),
      policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
      capabilityClasses: ["read-only" as const],
      payload,
    };
    const decision = decideReadOnlyItem(item, {
      runId: "run",
      mode: "dry-run",
      policy: "classify",
      policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
      inputHash: item.inputHash,
      actor: { type: "test", id: "unit" },
    });
    expect(decision).toMatchObject({
      inputHash: item.inputHash,
      policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
    });
  });
});
