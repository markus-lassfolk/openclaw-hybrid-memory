import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProposalsDB } from "../backends/proposals-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { _testing } from "../index.js";
import { runDreamCycleProposalBridge } from "../services/dream-cycle-proposal-bridge.js";

const { FactsDB } = _testing;

describe("dream-cycle proposal bridge", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let proposalsDb: ProposalsDB;
  let cfg: HybridMemoryConfig;
  let ruleFactId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-bridge-"));
    writeFileSync(join(tmpDir, "SOUL.md"), "# SOUL\nBe precise.\n", "utf-8");
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
    cfg = {
      personaProposals: {
        enabled: true,
        autoApply: false,
        allowedFiles: ["SOUL.md", "IDENTITY.md", "USER.md"],
        maxProposalsPerWeek: 5,
        minConfidence: 0.7,
        proposalTTLDays: 30,
        minSessionEvidence: 1,
        requireScopeFilter: false,
        separateSelfCorrectionQuota: true,
      },
      nightlyCycle: { autoPropose: true },
    } as HybridMemoryConfig;
    const stored = factsDb.store({
      text: "Always verify GitHub state with gh before claiming PR merge readiness.",
      category: "rule",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "dream-cycle-test",
    });
    ruleFactId = stored.id;
  });

  afterEach(() => {
    proposalsDb.close();
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates allowlisted persona proposals for newly stored rules only", () => {
    const result = runDreamCycleProposalBridge({
      cfg,
      factsDb,
      proposalsDb,
      patternsStored: 0,
      rulesGenerated: 1,
      newRuleFactIds: [ruleFactId],
      logger: { info: () => {}, warn: () => {} },
      workspaceRoot: tmpDir,
    });
    expect(result.personaProposalsCreated).toBeGreaterThan(0);
    const created = proposalsDb.list({ status: "pending" });
    expect(created.length).toBeGreaterThan(0);
    for (const proposal of created) {
      expect(cfg.personaProposals.allowedFiles).toContain(proposal.targetFile);
      expect(proposal.targetHash).toBeTruthy();
      expect(proposal.evidenceSessions.length).toBeGreaterThan(0);
      expect(existsSync(join(tmpDir, proposal.targetFile))).toBe(true);
    }
  });

  it("does not re-propose existing rules when newRuleFactIds is omitted", () => {
    const result = runDreamCycleProposalBridge({
      cfg,
      factsDb,
      proposalsDb,
      patternsStored: 0,
      rulesGenerated: 1,
      logger: { info: () => {}, warn: () => {} },
      workspaceRoot: tmpDir,
    });
    expect(result.personaProposalsCreated).toBe(0);
    expect(proposalsDb.list().length).toBe(0);
  });

  it("skips duplicate pending proposals for the same rule text", () => {
    runDreamCycleProposalBridge({
      cfg,
      factsDb,
      proposalsDb,
      patternsStored: 0,
      rulesGenerated: 1,
      newRuleFactIds: [ruleFactId],
      logger: { info: () => {}, warn: () => {} },
      workspaceRoot: tmpDir,
    });
    const second = runDreamCycleProposalBridge({
      cfg,
      factsDb,
      proposalsDb,
      patternsStored: 0,
      rulesGenerated: 1,
      newRuleFactIds: [ruleFactId],
      logger: { info: () => {}, warn: () => {} },
      workspaceRoot: tmpDir,
    });
    expect(second.personaProposalsCreated).toBe(0);
    expect(proposalsDb.list({ status: "pending" }).length).toBe(1);
  });

  it("skips auto-propose when nightlyCycle.autoPropose is false", () => {
    const result = runDreamCycleProposalBridge({
      cfg: { ...cfg, nightlyCycle: { autoPropose: false } } as HybridMemoryConfig,
      factsDb,
      proposalsDb,
      patternsStored: 0,
      rulesGenerated: 1,
      newRuleFactIds: [ruleFactId],
      logger: { info: () => {}, warn: () => {} },
      workspaceRoot: tmpDir,
    });
    expect(result.personaProposalsCreated).toBe(0);
    expect(proposalsDb.list().length).toBe(0);
  });

  it("creates crystallization proposals for dream-cycle patterns", async () => {
    const { CrystallizationStore } = await import("../backends/crystallization-store.js");
    const crystallizationStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    const pattern = factsDb.store({
      text: "When debugging CI, always inspect the failing check logs before pushing fixes.",
      category: "pattern",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "dream-cycle-test",
    });
    const result = runDreamCycleProposalBridge({
      cfg: {
        ...cfg,
        crystallization: { enabled: true, maxCrystallized: 10 },
      } as HybridMemoryConfig,
      factsDb,
      proposalsDb,
      crystallizationStore,
      patternsStored: 1,
      rulesGenerated: 0,
      newPatternFactIds: [pattern.id],
      logger: { info: () => {}, warn: () => {} },
      workspaceRoot: tmpDir,
    });
    expect(result.crystallizationProposalsCreated).toBe(1);
    const pending = crystallizationStore.list({ status: "pending" });
    expect(pending.length).toBeGreaterThan(0);
    crystallizationStore.close();
  });
});
