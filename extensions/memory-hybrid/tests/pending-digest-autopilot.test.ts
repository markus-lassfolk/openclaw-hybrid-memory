import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
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
  stablePendingDigestAutopilotJson,
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
    embedding: {
      apiKey: "sk-test-embed-key-that-is-long-enough",
      model: "text-embedding-3-small",
    },
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
        byReason: {
          awaiting_approval: 1,
          missing_anchor: 1,
          unknown: 0,
          duplicate_skill: 0,
          low_recall: 0,
        },
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
  it("defaults to dry-run, inspects live pending queues, emits stable structured JSON, and does not open durable state", async () => {
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
      reasonCode: "identity-boundary-change",
    });
    expect(result.queues.tools.decisions[0]).toMatchObject({
      action: "classified",
      reasonCode: "dry-run",
    });
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      schemaVersion: 1,
      runId: "run-dry",
      policies: {
        persona: "cautious",
        procedures: "auto-safe",
        verified: "classify",
        tools: "classify",
      },
      counts: { inspected: 7, applied: 0 },
    });

    expect(existsSync(stateDb)).toBe(false);
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

    expect(first.applyBehavior).toBe("child-guarded-persona-apply");
    expect(first.queues.tools.decisions[0]).toMatchObject({
      action: "classified",
      humanReviewRequired: false,
      reasonCode: "policy-threshold-not-met",
      capabilityClass: "read-only",
    });
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

  it("apply mode persona cursor pagination advances only after guarded child state mutations", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const paths = pendingStorePaths(cfg.sqlitePath);
    const persona = new ProposalsDB(paths.proposals);
    const oldest = persona.create({
      targetFile: "USER.md",
      title: "Oldest duplicate/noise",
      observation: "Supported by test evidence",
      suggestedChange: "be better",
      confidence: 0.9,
      evidenceSessions: ["session-oldest"],
    });
    const middle = persona.create({
      targetFile: "USER.md",
      title: "Middle duplicate/noise",
      observation: "Supported by test evidence",
      suggestedChange: "improve",
      confidence: 0.9,
      evidenceSessions: ["session-middle"],
    });
    const newest = persona.create({
      targetFile: "USER.md",
      title: "Newest duplicate/noise",
      observation: "Supported by test evidence",
      suggestedChange: "do better",
      confidence: 0.9,
      evidenceSessions: ["session-newest"],
    });
    persona.close();
    const raw = new DatabaseSync(paths.proposals);
    raw.prepare("UPDATE proposals SET created_at = ? WHERE id IN (?, ?, ?)").run(100, oldest.id, middle.id, newest.id);
    raw.close();
    const expectedNewestFirst = [oldest.id, middle.id, newest.id].sort().reverse();
    const stateDb = join(dir, "autopilot.db");

    const first = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      stateDbPath: stateDb,
      mode: "apply",
      runId: "run-cursor-1",
      max: { persona: 1, procedures: 0, verified: 0, tools: 0, crystallization: 0 },
    });
    const second = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      stateDbPath: stateDb,
      mode: "apply",
      runId: "run-cursor-2",
      max: { persona: 1, procedures: 0, verified: 0, tools: 0, crystallization: 0 },
    });
    const third = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      stateDbPath: stateDb,
      mode: "apply",
      runId: "run-cursor-3",
      max: { persona: 1, procedures: 0, verified: 0, tools: 0, crystallization: 0 },
    });

    expect(first.queues.persona.decisions.map((d) => d.itemId)).toEqual([expectedNewestFirst[0]]);
    expect(second.queues.persona.decisions.map((d) => d.itemId)).toEqual([expectedNewestFirst[1]]);
    expect(third.queues.persona.decisions.map((d) => d.itemId)).toEqual([expectedNewestFirst[2]]);
    const reopened = new ProposalsDB(paths.proposals);
    expect(
      [reopened.get(oldest.id)?.status, reopened.get(middle.id)?.status, reopened.get(newest.id)?.status].sort(),
    ).toEqual(["rejected", "rejected", "rejected"]);
    reopened.close();
  });

  it("parent persona apply binds child triage to each iterated proposal behind a newer deferred item", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const paths = pendingStorePaths(cfg.sqlitePath);
    const persona = new ProposalsDB(paths.proposals);
    const olderReject = persona.create({
      targetFile: "USER.md",
      title: "Older non-actionable cleanup",
      observation: "Supported by test evidence.",
      suggestedChange: "be better",
      confidence: 0.9,
      evidenceSessions: ["session-older-reject"],
    });
    const oldestReject = persona.create({
      targetFile: "USER.md",
      title: "Oldest non-actionable cleanup",
      observation: "Supported by test evidence.",
      suggestedChange: "improve",
      confidence: 0.9,
      evidenceSessions: ["session-oldest-reject"],
    });
    const newerDeferred = persona.create({
      targetFile: "USER.md",
      title: "Newer material persona preference",
      observation: "The user prefers a different communication pattern.",
      suggestedChange: "Always use a more casual tone when replying to the user.",
      confidence: 0.95,
      evidenceSessions: ["session-newer"],
    });
    persona.close();
    const raw = new DatabaseSync(paths.proposals);
    raw.prepare("UPDATE proposals SET created_at = ? WHERE id = ?").run(100, oldestReject.id);
    raw.prepare("UPDATE proposals SET created_at = ? WHERE id = ?").run(200, olderReject.id);
    raw.prepare("UPDATE proposals SET created_at = ? WHERE id = ?").run(300, newerDeferred.id);
    raw.close();
    const stateDb = join(dir, "autopilot.db");

    const result = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      stateDbPath: stateDb,
      mode: "apply",
      policies: { persona: "cautious" },
      max: { persona: 3, procedures: 0, verified: 0, tools: 0, crystallization: 0 },
      runId: "run-parent-targeted-persona-apply",
    });

    expect(result.queues.persona.decisions.map((d) => d.itemId)).toEqual([
      newerDeferred.id,
      olderReject.id,
      oldestReject.id,
    ]);
    expect(result.queues.persona.decisions.map((d) => d.action)).toEqual([
      "deferred-for-human",
      "rejected",
      "rejected",
    ]);

    const reopened = new ProposalsDB(paths.proposals);
    expect(reopened.get(newerDeferred.id)?.status).toBe("pending");
    expect(reopened.get(olderReject.id)?.status).toBe("rejected");
    expect(reopened.get(oldestReject.id)?.status).toBe("rejected");
    reopened.close();

    const store = new PendingAutopilotStore(stateDb);
    expect(store.getCursor("persona", "cautious")).toBeNull();
    expect(store.listDecisions({ queue: "persona", itemId: newerDeferred.id }).map((d) => d.action)).toEqual([
      "deferred-for-human",
    ]);
    expect(store.listDecisions({ queue: "persona", itemId: olderReject.id }).map((d) => d.action)).toEqual([
      "rejected",
    ]);
    expect(store.listDecisions({ queue: "persona", itemId: oldestReject.id }).map((d) => d.action)).toEqual([
      "rejected",
    ]);
    store.close();

    const followup = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      stateDbPath: stateDb,
      mode: "apply",
      policies: { persona: "cautious" },
      max: { persona: 1, procedures: 0, verified: 0, tools: 0, crystallization: 0 },
      runId: "run-parent-targeted-persona-apply-followup",
    });
    expect(followup.queues.persona.decisions.map((d) => d.itemId)).toEqual([newerDeferred.id]);
  });

  it("parent persona cursor stays blocked by an already-recorded deferred item", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const paths = pendingStorePaths(cfg.sqlitePath);
    const persona = new ProposalsDB(paths.proposals);
    const older = persona.create({
      targetFile: "USER.md",
      title: "Older non-actionable cleanup",
      observation: "Supported by test evidence.",
      suggestedChange: "be better",
      confidence: 0.9,
      evidenceSessions: ["session-older"],
    });
    const newerDeferred = persona.create({
      targetFile: "USER.md",
      title: "Newer material persona preference",
      observation: "The user prefers a different communication pattern.",
      suggestedChange: "Always use a more casual tone when replying to the user.",
      confidence: 0.95,
      evidenceSessions: ["session-newer"],
    });
    persona.close();
    const raw = new DatabaseSync(paths.proposals);
    raw.prepare("UPDATE proposals SET created_at = ? WHERE id = ?").run(100, older.id);
    raw.prepare("UPDATE proposals SET created_at = ? WHERE id = ?").run(200, newerDeferred.id);
    raw.close();
    const stateDb = join(dir, "autopilot.db");

    const first = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      stateDbPath: stateDb,
      mode: "apply",
      policies: { persona: "cautious" },
      max: { persona: 1, procedures: 0, verified: 0, tools: 0, crystallization: 0 },
      runId: "run-cursor-deferred-1",
    });
    const second = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      stateDbPath: stateDb,
      mode: "apply",
      policies: { persona: "cautious" },
      max: { persona: 2, procedures: 0, verified: 0, tools: 0, crystallization: 0 },
      runId: "run-cursor-deferred-2",
    });

    expect(first.queues.persona.decisions.map((d) => d.itemId)).toEqual([newerDeferred.id]);
    expect(first.queues.persona.decisions[0]).toMatchObject({
      action: "deferred-for-human",
      humanReviewRequired: true,
    });
    expect(second.queues.persona.decisions.map((d) => d.itemId)).toEqual([newerDeferred.id, older.id]);
    expect(second.queues.persona.decisions[0]).toMatchObject({
      action: "deferred-for-human",
      humanReviewRequired: true,
    });
    expect(second.queues.persona.decisions[1]).toMatchObject({
      action: "rejected",
      humanReviewRequired: false,
    });

    const store = new PendingAutopilotStore(stateDb);
    expect(store.getCursor("persona", "cautious")).toBeNull();
    store.close();

    const third = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      stateDbPath: stateDb,
      mode: "apply",
      policies: { persona: "cautious" },
      max: { persona: 1, procedures: 0, verified: 0, tools: 0, crystallization: 0 },
      runId: "run-cursor-deferred-3",
    });
    expect(third.queues.persona.decisions.map((d) => d.itemId)).toEqual([newerDeferred.id]);

    const reopened = new ProposalsDB(paths.proposals);
    expect(reopened.get(newerDeferred.id)?.status).toBe("pending");
    reopened.close();
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

    expect(result.queues.tools).toMatchObject({
      skipped: true,
      skipReason: "queue-disabled-by-policy",
      inspected: 0,
    });
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

  it("requires a state DB before apply mode can record parent decisions", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    seedQueues(cfg);

    await expect(
      runPendingDigestAutopilot({
        cfg,
        factsDb: factsDb(),
        mode: "apply",
        runId: "run-apply-no-state",
      }),
    ).rejects.toThrow("--apply requires --state-db");
  });

  it("validates apply prerequisites before constructing default adapters", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const listSpy = vi.spyOn(ProposalsDB.prototype, "list");

    await expect(
      runPendingDigestAutopilot({
        cfg,
        factsDb: factsDb(),
        mode: "apply",
        runId: "run-apply-no-state-no-adapter-side-effects",
      }),
    ).rejects.toThrow("--apply requires --state-db");

    expect(listSpy).not.toHaveBeenCalled();
    const paths = pendingStorePaths(cfg.sqlitePath);
    expect(existsSync(paths.proposals)).toBe(false);
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

    expect(result.queues.tools).toMatchObject({
      skipped: true,
      skipReason: "inventory-failed",
    });
    expect(result.queues.tools.decisions[0]).toMatchObject({
      action: "failed-validation",
      reasonCode: "schema-validation-failed",
      humanReviewRequired: true,
    });
    expect(result.humanSummary).toContain("failed validation 1");
  });

  it("closes persona proposal DB handles opened by the parent adapter", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    seedQueues(cfg);
    const closeSpy = vi.spyOn(ProposalsDB.prototype, "close");

    await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      runId: "run-close-persona-db-handles",
      max: { procedures: 0, verified: 0, tools: 0, crystallization: 0 },
    });

    expect(closeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("parent persona adapter refreshes proposals before each decision", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const paths = pendingStorePaths(cfg.sqlitePath);
    const persona = new ProposalsDB(paths.proposals);
    const older = persona.create({
      targetFile: "USER.md",
      title: "Older duplicate",
      observation: "Existing duplicate proposal.",
      suggestedChange: "Formatting: duplicate parent adapter marker.",
      confidence: 0.99,
      evidenceSessions: ["session-old"],
    });
    const newer = persona.create({
      targetFile: "USER.md",
      title: "Newer duplicate",
      observation: "Duplicate proposal to classify.",
      suggestedChange: "Formatting: duplicate parent adapter marker.",
      confidence: 0.99,
      evidenceSessions: ["session-new"],
    });
    persona.close();
    const raw = new DatabaseSync(paths.proposals);
    raw.prepare("UPDATE proposals SET created_at = ? WHERE id = ?").run(100, older.id);
    raw.prepare("UPDATE proposals SET created_at = ? WHERE id = ?").run(200, newer.id);
    raw.close();

    const adapters = createDefaultPendingDigestAdapters({ cfg, factsDb: factsDb() });
    const listed = (await adapters.persona.listPending(null)) as PendingItem[];
    const newerItem = listed.find((item) => item.id === newer.id);
    expect(newerItem).toBeDefined();

    const mutator = new ProposalsDB(paths.proposals);
    mutator.markApplied(older.id);
    mutator.close();

    const decision = await adapters.persona.decide(newerItem as PendingItem, {
      runId: "run-parent-persona-refresh",
      mode: "apply",
      policy: "cautious",
      policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
      inputHash: newerItem?.inputHash ?? "missing",
      actor: { type: "test", id: "unit" },
    });

    expect(decision).toMatchObject({
      itemId: newer.id,
      action: "rejected",
      reasonCode: "duplicate-applied-proposal",
    });
  });

  it("passes the caller workspace through the parent persona adapter", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const callerWorkspace = join(dir, "caller-workspace");
    const defaultWorkspace = join(dir, "default-workspace");
    mkdirSync(callerWorkspace, { recursive: true });
    mkdirSync(defaultWorkspace, { recursive: true });
    writeFileSync(join(callerWorkspace, "AGENTS.md"), "# AGENTS\nCaller workspace.\n", "utf-8");
    writeFileSync(join(defaultWorkspace, "AGENTS.md"), "# AGENTS\nDefault workspace.\n", "utf-8");
    const previousWorkspace = process.env.OPENCLAW_WORKSPACE;
    process.env.OPENCLAW_WORKSPACE = defaultWorkspace;
    try {
      const paths = pendingStorePaths(cfg.sqlitePath);
      const persona = new ProposalsDB(paths.proposals);
      cfg.personaProposals.allowedFiles = [
        ...cfg.personaProposals.allowedFiles,
        "AGENTS.md",
      ] as typeof cfg.personaProposals.allowedFiles;
      const callerPreHash = fileHash(join(callerWorkspace, "AGENTS.md"));
      const defaultPreHash = fileHash(join(defaultWorkspace, "AGENTS.md"));
      const p = persona.create({
        targetFile: "AGENTS.md",
        title: "Caller workspace formatting",
        observation: "Formatting-only proposal for the caller workspace.",
        suggestedChange: "Formatting: parent adapter workspace marker.",
        confidence: 0.99,
        evidenceSessions: ["session-workspace"],
        targetHash: callerPreHash,
        targetMtimeMs: null,
      });
      persona.close();

      const result = await runPendingDigestAutopilot({
        cfg,
        factsDb: factsDb(),
        workspace: callerWorkspace,
        stateDbPath: join(dir, "autopilot.db"),
        mode: "apply",
        policies: { persona: "apply-safe" },
        max: { persona: 1, procedures: 0, verified: 0, tools: 0, crystallization: 0 },
        runId: "run-parent-persona-caller-workspace",
      });

      const decision = result.queues.persona.decisions[0];
      expect(decision).toMatchObject({
        itemId: p.id,
        action: "applied",
        reasonCode: "safe-low-risk-localized-change",
      });
      expect(decision?.summary?.metadata).toMatchObject({
        targetHash: callerPreHash,
      });
      expect(decision?.summary?.metadata).not.toMatchObject({
        targetHash: defaultPreHash,
      });
    } finally {
      if (previousWorkspace === undefined) delete process.env.OPENCLAW_WORKSPACE;
      else process.env.OPENCLAW_WORKSPACE = previousWorkspace;
    }
  });

  it("parent route delegates to the same adapter decision path as standalone child route", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    seedQueues(cfg);
    const adapters = createDefaultPendingDigestAdapters({
      cfg,
      factsDb: factsDb(),
    });
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
      fixtures: [
        {
          item: fixture,
          policy: "cautious",
          policyVersion: fixture.policyVersion,
        },
      ],
    });
  });

  it("propagates default inventory store failures as inventory-failed decisions", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    vi.spyOn(ProposalsDB.prototype, "list").mockImplementation(() => {
      throw new Error("persona sqlite read failed");
    });

    const result = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      runId: "run-default-store-failure",
    });

    expect(result.queues.persona).toMatchObject({
      skipped: true,
      skipReason: "inventory-failed",
    });
    expect(result.queues.persona.decisions[0]).toMatchObject({
      action: "failed-validation",
      summary: { body: "persona sqlite read failed" },
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

  it("rejects conflicting dry-run/apply CLI flags and apply without state DB", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerManageDigest(program as never, { cfg, factsDb: factsDb() } as ManageBindings);

    await expect(
      program.parseAsync(["digest", "autopilot", "--dry-run", "--apply", "--state-db", join(dir, "state.db")], {
        from: "user",
      }),
    ).rejects.toThrow("--dry-run and --apply are mutually exclusive");
    await expect(program.parseAsync(["digest", "autopilot", "--apply"], { from: "user" })).rejects.toThrow(
      "--apply requires --state-db",
    );
  });

  it("uses canonical redacted JSON for stable structured output", async () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const result = await runPendingDigestAutopilot({
      cfg,
      factsDb: factsDb(),
      runId: "run-json-redaction",
      adapters: {
        tools: {
          queue: "tools",
          listPending: () => [
            {
              queue: "tools",
              id: "secret-tool",
              inputHash: computePendingInputHash({ id: "secret-tool" }),
              policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
              capabilityClasses: ["read-only"],
              payload: { title: "token: sk-test_secret_value_123456789" },
            },
          ],
          decide: decideReadOnlyItem,
        },
      },
    });

    const json = stablePendingDigestAutopilotJson(result);
    expect(json).toContain("[REDACTED]");
    expect(json).not.toContain("sk-test_secret_value_123456789");
    expect(Object.keys(JSON.parse(json))).toEqual([
      "applyBehavior",
      "counts",
      "digestContext",
      "foundationSummary",
      "humanSummary",
      "max",
      "mode",
      "policies",
      "policyVersion",
      "queues",
      "runId",
      "schemaVersion",
    ]);
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

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
