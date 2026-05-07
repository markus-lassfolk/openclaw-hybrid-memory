import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { ToolProposalStore } from "../backends/tool-proposal-store.js";
import { hybridConfigSchema, type HybridMemoryConfig } from "../config.js";
import {
  buildPendingReviewDigestReport,
  countPendingReviewBacklogs,
  pendingStorePaths,
  renderPendingReviewDigestMarkdown,
} from "../services/pending-review-digest.js";
import { _testing } from "../index.js";

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
      skillName: "review-backlog",
      skillContent: "# Skill",
      patternSnapshot: "{}",
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

    const counts = countPendingReviewBacklogs(cfg, factsDb);
    expect(counts).toMatchObject(report.pendingReview);

    persona.close();
    tools.close();
    crystal.close();
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

    persona.close();
    factsDb.close();
  });
});
