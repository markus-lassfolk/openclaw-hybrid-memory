import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { ToolProposalStore } from "../backends/tool-proposal-store.js";
import { type HybridMemoryConfig, hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";
import {
  buildPendingReviewDigestReport,
  countPendingReviewBacklogs,
  pendingStorePaths,
  renderPendingReviewDigestMarkdown,
} from "../services/pending-review-digest.js";

const { FactsDB } = _testing;

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

describe("pending review digest (#1197)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function newDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "hybrid-mem-pending-digest-"));
    dirs.push(dir);
    return dir;
  }

  it("returns a versioned stable JSON schema and real backlog counts", () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const paths = pendingStorePaths(cfg.sqlitePath);
    const factsDb = new FactsDB(cfg.sqlitePath);
    const persona = new ProposalsDB(paths.proposals);
    const tools = new ToolProposalStore(paths.toolProposals);
    const crystal = new CrystallizationStore(paths.crystallization);

    persona.create({
      targetFile: "SOUL.md",
      title: "Prefer concise updates",
      observation: "Operator prefers short progress notes.",
      suggestedChange: "Use milestone updates.",
      confidence: 0.82,
      evidenceSessions: ["session-a"],
    });
    tools.create({
      name: "memory_digest_sender",
      description: "Send digest to configured channel",
      parameters: "{}",
      rationale: "Operator review backlog needs surfacing",
      sourcePatterns: "[]",
      implementationHint: "Use gateway delivery",
    });
    crystal.create({
      patternId: "pattern-1",
      evidenceHash: "ev1",
      skillName: "review-backlog",
      skillContent: "# Skill",
      patternSnapshot: "{}",
      validationResult: {
        schemaVersion: 1,
        validatedAt: "2026-05-07T00:00:00.000Z",
        overallStatus: "warn",
        approvalDecision: "allow-with-override",
        staticValidation: {
          status: "passed",
          violations: [],
          frontmatter: { name: "review-backlog", description: "Review backlog", category: "crystallized-workflow" },
          safeOutputPath: "/tmp/review-backlog/SKILL.md",
        },
        dryLoadValidation: {
          status: "passed",
          violations: [],
          discovered: { name: "review-backlog", description: "Review backlog", category: "crystallized-workflow" },
        },
        syntheticActivationEval: {
          status: "warn",
          score: 67,
          cases: {
            positive: "Review the backlog",
            negative: "How do I create a GitHub issue?",
            edge: "Explain the backlog without executing the workflow.",
          },
          results: { positiveMatched: true, negativeMatched: false, edgeMatched: true },
          notes: ["Edge eval looks too broad and would likely over-trigger"],
        },
        canarySession: { status: "not-run" },
      },
    });
    factsDb.upsertProcedure({
      taskPattern: "Review pending procedure",
      recipeJson: JSON.stringify([{ tool: "inspect" }, { tool: "promote" }]),
      procedureType: "positive",
      successCount: 5,
      lastValidated: Math.floor(Date.now() / 1000),
      confidence: 0.9,
    });

    const report = buildPendingReviewDigestReport({
      cfg,
      factsDb,
      since: "7d",
      now: new Date("2026-05-07T00:00:00.000Z"),
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.generatedAt).toBe("2026-05-07T00:00:00.000Z");
    expect(report.pendingReview).toMatchObject({ persona: 1, procedures: 1, tools: 1, crystallization: 1 });
    expect(report.personaProposals.pendingEntries[0]).toHaveProperty("approveCommand");
    expect(report.personaProposals.pendingEntries[0]).toMatchObject({
      evidence: { topFactIds: [], facts: 0 },
    });
    expect(report.procedures.newThisWeek).toBeGreaterThanOrEqual(1);
    expect(report.toolProposals.proposedEntries[0]).toHaveProperty("declineCommand");
    expect(report.crystallization.pendingEntries[0]).toHaveProperty("approveCommand");
    expect(report.crystallization.pendingEntries[0].validation).toContain("WARN");

    const counts = countPendingReviewBacklogs(cfg, factsDb);
    expect(counts).toMatchObject(report.pendingReview);

    persona.close();
    tools.close();
    crystal.close();
    factsDb.close();
  });

  it("sets truncated=0 and no marker when all pending entries fit in the window and cap", () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const paths = pendingStorePaths(cfg.sqlitePath);
    const factsDb = new FactsDB(cfg.sqlitePath);
    const persona = new ProposalsDB(paths.proposals);
    persona.create({
      targetFile: "USER.md",
      title: "Keep replies concise",
      observation: "User corrected verbosity.",
      suggestedChange: "Prefer direct answers.",
      confidence: 0.77,
      evidenceSessions: ["session-c"],
    });

    const report = buildPendingReviewDigestReport({
      cfg,
      factsDb,
      since: "7d",
      now: new Date("2026-05-07T00:00:00.000Z"),
    });

    expect(report.personaProposals.pending).toBe(1);
    expect(report.personaProposals.truncated).toBe(0);
    expect(report.personaProposals.pendingEntries).toHaveLength(1);

    const md = renderPendingReviewDigestMarkdown(report);
    expect(md).not.toContain("omitted");

    persona.close();
    factsDb.close();
  });

  it("sets truncated and renders a truncation marker when proposals are outside the lookback window (#1742)", () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const paths = pendingStorePaths(cfg.sqlitePath);
    const factsDb = new FactsDB(cfg.sqlitePath);
    const persona = new ProposalsDB(paths.proposals);

    // Create two proposals within the normal window first, then backdate them
    const nowEpoch = Math.floor(new Date("2026-05-07T00:00:00.000Z").getTime() / 1000);
    const oldEpoch = nowEpoch - 8 * 24 * 3600; // 8 days ago — outside 7d window

    const p1 = persona.create({
      targetFile: "FILE_0.md",
      title: "Old proposal 0",
      observation: "Old observation.",
      suggestedChange: "Old change.",
      confidence: 0.7,
      evidenceSessions: [],
    });
    const p2 = persona.create({
      targetFile: "FILE_1.md",
      title: "Old proposal 1",
      observation: "Old observation.",
      suggestedChange: "Old change.",
      confidence: 0.7,
      evidenceSessions: [],
    });

    // One proposal within the window (createdAt stays at current time which is before "now")
    persona.create({
      targetFile: "SOUL.md",
      title: "Recent proposal",
      observation: "Recent observation.",
      suggestedChange: "Recent change.",
      confidence: 0.9,
      evidenceSessions: [],
    });

    // Close the store, then use a raw DatabaseSync to backdate the two old proposals
    persona.close();
    const rawDb = new DatabaseSync(paths.proposals);
    const backdate = rawDb.prepare("UPDATE proposals SET created_at = ? WHERE id = ?");
    backdate.run(oldEpoch, p1.id);
    backdate.run(oldEpoch, p2.id);
    rawDb.close();

    const report = buildPendingReviewDigestReport({
      cfg,
      factsDb,
      since: "7d",
      now: new Date("2026-05-07T00:00:00.000Z"),
    });

    // 3 pending total; only 1 in the 7d window → 2 truncated
    expect(report.personaProposals.pending).toBe(3);
    expect(report.personaProposals.pendingEntries).toHaveLength(1);
    expect(report.personaProposals.truncated).toBe(2);

    const md = renderPendingReviewDigestMarkdown(report);
    expect(md).toContain("Showing 1 of 3 pending persona proposals");
    expect(md).toContain("2 omitted");
    expect(md).toContain("openclaw hybrid-mem proposals list --status pending");

    factsDb.close();
  });

  it("sets truncated and renders a truncation marker when more than 10 recent proposals exist (#1742)", () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const paths = pendingStorePaths(cfg.sqlitePath);
    const factsDb = new FactsDB(cfg.sqlitePath);
    const persona = new ProposalsDB(paths.proposals);

    // Create 12 proposals — all within the 7d window (default createdAt = now)
    for (let i = 0; i < 12; i++) {
      persona.create({
        targetFile: `FILE_${i}.md`,
        title: `Proposal ${i}`,
        observation: "Observation.",
        suggestedChange: "Change.",
        confidence: 0.8,
        evidenceSessions: [],
      });
    }

    const report = buildPendingReviewDigestReport({
      cfg,
      factsDb,
      since: "7d",
      now: new Date("2026-05-07T00:00:00.000Z"),
    });

    // Cap is 10; 12 pending → 2 truncated
    expect(report.personaProposals.pending).toBe(12);
    expect(report.personaProposals.pendingEntries).toHaveLength(10);
    expect(report.personaProposals.truncated).toBe(2);

    const md = renderPendingReviewDigestMarkdown(report);
    expect(md).toContain("Showing 10 of 12 pending persona proposals");
    expect(md).toContain("2 omitted");
    expect(md).toContain("openclaw hybrid-mem proposals list --status pending");

    persona.close();
    factsDb.close();
  });

  it("counts pending proposals past expires_at as expired", () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const paths = pendingStorePaths(cfg.sqlitePath);
    const factsDb = new FactsDB(cfg.sqlitePath);
    const persona = new ProposalsDB(paths.proposals);
    const now = new Date("2026-05-07T00:00:00.000Z");
    const nowSec = Math.floor(now.getTime() / 1000);
    persona.create({
      targetFile: "USER.md",
      title: "Expired pending",
      observation: "Should count as expired",
      suggestedChange: "Append note",
      confidence: 0.8,
      evidenceSessions: ["session-x"],
      expiresAt: nowSec - 3600,
    });
    persona.create({
      targetFile: "USER.md",
      title: "Still valid",
      observation: "Not expired",
      suggestedChange: "Append note",
      confidence: 0.8,
      evidenceSessions: ["session-y"],
      expiresAt: nowSec + 3600,
    });

    const report = buildPendingReviewDigestReport({ cfg, factsDb, now });
    expect(report.personaProposals.pending).toBe(2);
    expect(report.personaProposals.expired).toBe(1);

    persona.close();
    factsDb.close();
  });

  it("renders approve, decline, and defer operator commands in markdown", () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const paths = pendingStorePaths(cfg.sqlitePath);
    const factsDb = new FactsDB(cfg.sqlitePath);
    const persona = new ProposalsDB(paths.proposals);
    persona.create({
      targetFile: "USER.md",
      title: "Keep replies practical",
      observation: "User corrected verbosity.",
      suggestedChange: "Prefer direct answers.",
      confidence: 0.77,
      evidenceSessions: ["session-b"],
    });

    const md = renderPendingReviewDigestMarkdown(
      buildPendingReviewDigestReport({ cfg, factsDb, now: new Date("2026-05-07T00:00:00.000Z") }),
    );
    expect(md).toContain("Pending review (proposals/procedures/tools/crystal/verified): 1/0/0/0/0");
    expect(md).toContain("Approve: openclaw hybrid-mem proposals approve");
    expect(md).toContain("Decline: openclaw hybrid-mem proposals reject");
    expect(md).toContain("Defer:");
    expect(md).toContain("## Crystallization proposals (0)");

    persona.close();
    factsDb.close();
  });
});

describe("pending digest age hygiene (#2098)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function newDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "hybrid-mem-pending-digest-age-"));
    dirs.push(dir);
    return dir;
  }

  it("buckets persona proposals into 0-1d/1-7d/7-30d/30d+ and reports oldest/newest", () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const paths = pendingStorePaths(cfg.sqlitePath);
    const factsDb = new FactsDB(cfg.sqlitePath);
    const persona = new ProposalsDB(paths.proposals);
    const now = new Date("2026-05-07T00:00:00.000Z");
    const nowSec = Math.floor(now.getTime() / 1000);

    const fresh = persona.create({
      targetFile: "SOUL.md",
      title: "Fresh proposal",
      observation: "o",
      suggestedChange: "c",
      confidence: 0.8,
      evidenceSessions: [],
    });
    const midAge = persona.create({
      targetFile: "SOUL.md",
      title: "Mid-age proposal",
      observation: "o",
      suggestedChange: "c",
      confidence: 0.8,
      evidenceSessions: [],
    });
    const stale = persona.create({
      targetFile: "SOUL.md",
      title: "Stale proposal",
      observation: "o",
      suggestedChange: "c",
      confidence: 0.8,
      evidenceSessions: [],
    });
    persona.close();

    const rawDb = new DatabaseSync(paths.proposals);
    rawDb.prepare("UPDATE proposals SET created_at = ? WHERE id = ?").run(nowSec - 3 * 86400, midAge.id);
    rawDb.prepare("UPDATE proposals SET created_at = ? WHERE id = ?").run(nowSec - 45 * 86400, stale.id);
    rawDb.close();
    void fresh;

    // Use a lookback wide enough (60d) so all three pending entries survive the time-window
    // filter used for `pendingEntries`; ageHygiene itself is computed over the full backlog
    // regardless of the lookback window.
    const report = buildPendingReviewDigestReport({ cfg, factsDb, since: "60d", now });

    expect(report.personaProposals.ageHygiene.ageBuckets).toEqual({ d0_1: 1, d1_7: 1, d7_30: 0, d30plus: 1 });
    expect(report.personaProposals.ageHygiene.oldestAgeDays).toBe(45);
    expect(report.personaProposals.ageHygiene.newestAgeDays).toBe(0);
    expect(report.personaProposals.ageHygiene.recommendedNextAction).toMatch(/30d\+/);
    expect(report.personaProposals.ageHygiene.recommendedNextAction).toContain(
      "openclaw hybrid-mem proposals list --status pending",
    );

    factsDb.close();
  });

  it("reports an empty-backlog recommendation and null oldest/newest when a queue has nothing pending", () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const factsDb = new FactsDB(cfg.sqlitePath);

    const report = buildPendingReviewDigestReport({ cfg, factsDb, now: new Date("2026-05-07T00:00:00.000Z") });

    expect(report.toolProposals.ageHygiene.oldestAgeDays).toBeNull();
    expect(report.toolProposals.ageHygiene.newestAgeDays).toBeNull();
    expect(report.toolProposals.ageHygiene.ageBuckets).toEqual({ d0_1: 0, d1_7: 0, d7_30: 0, d30plus: 0 });
    expect(report.toolProposals.ageHygiene.recommendedNextAction).toMatch(/empty/);

    factsDb.close();
  });

  it("surfaces createdAt/ageDays on tool and crystallization pending entries", () => {
    const dir = newDir();
    const cfg = configFor(join(dir, "facts.db"));
    const paths = pendingStorePaths(cfg.sqlitePath);
    const factsDb = new FactsDB(cfg.sqlitePath);
    const tools = new ToolProposalStore(paths.toolProposals);
    const crystal = new CrystallizationStore(paths.crystallization);

    tools.create({
      name: "memory_digest_sender",
      description: "Send digest to configured channel",
      parameters: "{}",
      rationale: "r",
      sourcePatterns: "[]",
      implementationHint: "hint",
    });
    crystal.create({
      patternId: "pattern-1",
      evidenceHash: "ev1",
      skillName: "review-backlog",
      skillContent: "# Skill",
      patternSnapshot: "{}",
      validationResult: {
        schemaVersion: 1,
        validatedAt: "2026-05-07T00:00:00.000Z",
        overallStatus: "passed",
        approvalDecision: "allow",
        staticValidation: {
          status: "passed",
          violations: [],
          frontmatter: { name: "review-backlog", description: "Review backlog", category: "crystallized-workflow" },
          safeOutputPath: "/tmp/review-backlog/SKILL.md",
        },
        dryLoadValidation: {
          status: "passed",
          violations: [],
          discovered: { name: "review-backlog", description: "Review backlog", category: "crystallized-workflow" },
        },
        syntheticActivationEval: {
          status: "passed",
          score: 90,
          cases: { positive: "p", negative: "n", edge: "e" },
          results: { positiveMatched: true, negativeMatched: false, edgeMatched: true },
          notes: [],
        },
        canarySession: { status: "not-run" },
      },
    });
    tools.close();
    crystal.close();

    const report = buildPendingReviewDigestReport({ cfg, factsDb, now: new Date("2026-05-07T00:00:00.000Z") });

    expect(report.toolProposals.proposedEntries[0]).toMatchObject({ ageDays: 0 });
    expect(report.toolProposals.proposedEntries[0].createdAt).toBeTruthy();
    expect(report.crystallization.pendingEntries[0]).toMatchObject({ ageDays: 0 });
    expect(report.crystallization.pendingEntries[0].createdAt).toBeTruthy();

    const md = renderPendingReviewDigestMarkdown(report);
    expect(md).toContain("[pending 0d] memory_digest_sender");
    expect(md).toContain("[pending 0d] review-backlog");

    factsDb.close();
  });
});
