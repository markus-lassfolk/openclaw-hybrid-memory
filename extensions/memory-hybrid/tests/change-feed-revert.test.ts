import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { ToolProposalStore } from "../backends/tool-proposal-store.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { _testing } from "../index.js";
import { ChangeFeed } from "../services/change-feed.js";
import { buildChangeRevertContext, revertChangeById } from "../services/change-feed-revert.js";
import { makeUnifiedKey } from "../services/unified-proposals.js";
import { writeProposalRollback } from "../services/proposal-rollback.js";
import { withWorkshopDefaults } from "../services/workshop-service.js";
import { setEnv } from "../utils/env-manager.js";

const { FactsDB } = _testing;

type RevertTestContext = {
  tmpDir: string;
  proposalsDb: ProposalsDB;
  factsDb: InstanceType<typeof FactsDB>;
  changeFeed: ChangeFeed;
  cfg: HybridMemoryConfig;
  crystallizationStore: CrystallizationStore;
  workflowStore: WorkflowStore;
  toolProposalStore: ToolProposalStore;
};

function buildWorkshopCtx(ctx: RevertTestContext) {
  return withWorkshopDefaults({
    cfg: ctx.cfg,
    factsDb: ctx.factsDb,
    proposalsDb: ctx.proposalsDb,
    crystallizationStore: ctx.crystallizationStore,
    toolProposalStore: ctx.toolProposalStore,
    workflowStore: ctx.workflowStore,
    resolvedSqlitePath: join(ctx.tmpDir, "facts.db"),
    changeFeed: ctx.changeFeed,
  });
}

function buildRevertCtx(ctx: RevertTestContext) {
  return buildChangeRevertContext({
    changeFeed: ctx.changeFeed,
    cfg: ctx.cfg,
    sessionKey: "default",
    workshopCtx: buildWorkshopCtx(ctx),
  });
}

describe("change-feed revert", () => {
  let ctx: RevertTestContext;
  let originalWorkspace: string | undefined;

  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), "change-feed-revert-"));
    originalWorkspace = process.env.OPENCLAW_WORKSPACE;
    setEnv("OPENCLAW_WORKSPACE", tmpDir);
    writeFileSync(join(tmpDir, "SOUL.md"), "# SOUL\nInitial.\n", "utf-8");

    const proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
    const factsDb = new FactsDB(join(tmpDir, "facts.db"));
    const changeFeed = new ChangeFeed(factsDb);
    const crystallizationStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    const workflowStore = new WorkflowStore(join(tmpDir, "workflow.db"));
    const toolProposalStore = new ToolProposalStore(join(tmpDir, "tool-proposals.db"));

    ctx = {
      tmpDir,
      proposalsDb,
      factsDb,
      changeFeed,
      crystallizationStore,
      workflowStore,
      toolProposalStore,
      cfg: {
        health: { enabled: true },
        liveChangeFeed: { enabled: true },
        personaProposals: {
          enabled: true,
          autoApply: false,
          allowedFiles: ["SOUL.md", "IDENTITY.md", "USER.md"],
          maxProposalsPerWeek: 50,
          minConfidence: 0.5,
          proposalTTLDays: 30,
          minSessionEvidence: 1,
          requireScopeFilter: false,
          separateSelfCorrectionQuota: true,
        },
        crystallization: {
          enabled: true,
          minUsageCount: 2,
          minSuccessRate: 0.5,
          autoApprove: false,
          outputDir: join(tmpDir, "skills"),
          maxCrystallized: 50,
          pruneUnusedDays: 30,
          maxPendingProposals: 100,
          evidenceCountBucketSize: 5,
          placeholderEmailDomains: ["example.com"],
          excludeSystemGoals: true,
        },
        selfExtension: { enabled: true },
        procedures: { enabled: true },
      } as HybridMemoryConfig,
    };
  });

  afterEach(() => {
    ctx.proposalsDb.close();
    ctx.factsDb.close();
    ctx.crystallizationStore.close();
    ctx.workflowStore.close();
    ctx.toolProposalStore.close();
    if (originalWorkspace !== undefined) setEnv("OPENCLAW_WORKSPACE", originalWorkspace);
    else setEnv("OPENCLAW_WORKSPACE", undefined);
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  it("reverts applied persona change once without duplicate revert events", () => {
    const original = readFileSync(join(ctx.tmpDir, "SOUL.md"), "utf-8");
    const applied = "# SOUL\nInitial.\n\nApplied guidance.\n";
    writeFileSync(join(ctx.tmpDir, "SOUL.md"), applied, "utf-8");
    const proposal = ctx.proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Applied",
      observation: "obs",
      suggestedChange: "Applied guidance.",
      confidence: 0.9,
      evidenceSessions: [],
    });
    ctx.proposalsDb.updateStatusIf(proposal.id, "approved", "pending");
    ctx.proposalsDb.markAppliedIfApproved(proposal.id);
    writeProposalRollback(join(ctx.tmpDir, "facts.db"), {
      proposalId: proposal.id,
      proposalType: "persona",
      targetPath: join(ctx.tmpDir, "SOUL.md"),
      originalHash: createHash("sha256").update(original).digest("hex"),
      originalContent: original,
      appliedHash: createHash("sha256").update(applied).digest("hex"),
      appliedAt: new Date().toISOString(),
    });
    const key = makeUnifiedKey("persona", proposal.id);
    const appliedEvent = ctx.changeFeed.append({
      sessionKey: "default",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "applied",
      title: "Applied persona proposal",
      detail: "Applied to SOUL.md",
      proposalKey: key,
      rollbackAvailable: true,
      activation: "next-reload",
    });

    const result = revertChangeById(buildRevertCtx(ctx), appliedEvent.id);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(ctx.tmpDir, "SOUL.md"), "utf-8")).toBe(original);
    expect(ctx.proposalsDb.get(proposal.id)?.status).toBe("pending");
    expect(ctx.changeFeed.getById(appliedEvent.id)?.status).toBe("reverted");

    const revertedEvents = ctx.changeFeed
      .listRecent({ sessionKey: "default", limit: 20 })
      .filter((e) => e.action === "reverted");
    expect(revertedEvents).toHaveLength(1);
  });

  it("reverts a pending proposed persona change via workshopReject", () => {
    const proposal = ctx.proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Pending rule",
      observation: "obs",
      suggestedChange: "Prefer concise replies during dream cycle.",
      confidence: 0.8,
      evidenceSessions: [],
    });
    const key = makeUnifiedKey("persona", proposal.id);
    const proposedEvent = ctx.changeFeed.append({
      sessionKey: "default",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Persona proposal pending",
      detail: "Awaiting review",
      proposalKey: key,
      rollbackAvailable: false,
      activation: "next-reload",
    });

    const result = revertChangeById(buildRevertCtx(ctx), proposedEvent.id);
    expect(result.ok).toBe(true);
    expect(ctx.proposalsDb.get(proposal.id)?.status).toBe("rejected");
    expect(ctx.changeFeed.getById(proposedEvent.id)?.status).toBe("reverted");
    const revertedEvents = ctx.changeFeed
      .listRecent({ sessionKey: "default", limit: 20 })
      .filter((e) => e.action === "reverted");
    expect(revertedEvents).toHaveLength(1);
  });

  it("reverts an applied crystallization skill by quarantining the installed proposal", () => {
    const proposal = ctx.crystallizationStore.create({
      patternId: "pat-revert",
      evidenceHash: "ev-revert",
      skillName: "revert-skill",
      skillContent: "# Revert skill\n",
      patternSnapshot: "{}",
      status: "installed",
    });
    const key = makeUnifiedKey("crystallization", proposal.id);
    const appliedEvent = ctx.changeFeed.append({
      sessionKey: "default",
      timestamp: Date.now(),
      tier: "persistent",
      category: "skill",
      action: "applied",
      title: "Skill installed",
      detail: "Installed via workshop",
      proposalKey: key,
      rollbackAvailable: true,
      activation: "next-turn",
    });

    const result = revertChangeById(buildRevertCtx(ctx), appliedEvent.id);
    expect(result.ok).toBe(true);
    expect(ctx.crystallizationStore.getById(proposal.id)?.status).toBe("quarantined");
    expect(ctx.changeFeed.getById(appliedEvent.id)?.status).toBe("reverted");
    const revertedEvents = ctx.changeFeed
      .listRecent({ sessionKey: "default", limit: 20 })
      .filter((e) => e.action === "reverted");
    expect(revertedEvents).toHaveLength(1);
  });

  it("reverts a pending proposed tool change via workshopReject", () => {
    const tool = ctx.toolProposalStore.create({
      name: "memory_lookup",
      description: "Lookup helper",
      parameters: "{}",
      rationale: "Gap detected",
      sourcePatterns: "[]",
      implementationHint: "Add tool",
    });
    const key = makeUnifiedKey("tool", tool.id);
    const proposedEvent = ctx.changeFeed.append({
      sessionKey: "default",
      timestamp: Date.now(),
      tier: "persistent",
      category: "tool",
      action: "proposed",
      title: "Tool proposal pending",
      detail: "Awaiting review",
      proposalKey: key,
      rollbackAvailable: false,
      activation: "next-turn",
    });

    const result = revertChangeById(buildRevertCtx(ctx), proposedEvent.id);
    expect(result.ok).toBe(true);
    expect(ctx.toolProposalStore.getById(tool.id)?.status).toBe("rejected");
    expect(ctx.changeFeed.getById(proposedEvent.id)?.status).toBe("reverted");
  });

  it("reverts a pending proposed procedure-skill by dismissing via workshopReject", () => {
    const proc = ctx.factsDb.upsertProcedure({
      taskPattern: "Pending procedure skill",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 5,
    });
    const key = makeUnifiedKey("procedure-skill", proc.id);
    const proposedEvent = ctx.changeFeed.append({
      sessionKey: "default",
      timestamp: Date.now(),
      tier: "persistent",
      category: "procedure-skill",
      action: "proposed",
      title: "Procedure skill ready",
      detail: "Awaiting review",
      proposalKey: key,
      rollbackAvailable: true,
      activation: "next-turn",
    });

    const result = revertChangeById(buildRevertCtx(ctx), proposedEvent.id);
    expect(result.ok).toBe(true);
    expect(ctx.factsDb.getProcedureById(proc.id)?.skillState).toBe("rejected");
    expect(ctx.changeFeed.getById(proposedEvent.id)?.status).toBe("reverted");
  });

  it("reverts a pending skill-workshop proposal without workshop store", () => {
    const proposedEvent = ctx.changeFeed.append({
      sessionKey: "default",
      timestamp: Date.now(),
      tier: "persistent",
      category: "skill",
      action: "proposed",
      title: "Skill workshop proposal pending",
      detail: "Awaiting review",
      proposalKey: "skill-workshop:draft-1",
      rollbackAvailable: true,
      activation: "next-turn",
    });

    const result = revertChangeById(buildRevertCtx(ctx), proposedEvent.id);
    expect(result.ok).toBe(true);
    expect(ctx.changeFeed.getById(proposedEvent.id)?.status).toBe("reverted");
  });

  it("reverts an applied tool proposal via workshopWithdrawTool", () => {
    const tool = ctx.toolProposalStore.create({
      name: "memory_lookup",
      description: "Lookup helper",
      parameters: "{}",
      rationale: "Gap detected",
      sourcePatterns: "[]",
      implementationHint: "Add tool",
    });
    ctx.toolProposalStore.updateStatus(tool.id, "approved", "proposed");
    const key = makeUnifiedKey("tool", tool.id);
    const appliedEvent = ctx.changeFeed.append({
      sessionKey: "default",
      timestamp: Date.now(),
      tier: "persistent",
      category: "tool",
      action: "applied",
      title: "Tool proposal approved",
      detail: "Approved",
      proposalKey: key,
      rollbackAvailable: true,
      activation: "next-turn",
    });

    const result = revertChangeById(buildRevertCtx(ctx), appliedEvent.id);
    expect(result.ok).toBe(true);
    expect(ctx.toolProposalStore.getById(tool.id)?.status).toBe("rejected");
    expect(ctx.changeFeed.getById(appliedEvent.id)?.status).toBe("reverted");
  });

  it("reverts an applied procedure-skill by uninstalling the promoted skill", () => {
    const skillRelPath = "skills/auto/revert-proc";
    const skillAbsPath = join(ctx.tmpDir, skillRelPath);
    mkdirSync(skillAbsPath, { recursive: true });
    writeFileSync(join(skillAbsPath, "SKILL.md"), "# Procedure skill\n", "utf-8");

    const proc = ctx.factsDb.upsertProcedure({
      taskPattern: "Revert procedure skill",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 5,
    });
    ctx.factsDb.markProcedurePromoted(proc.id, skillRelPath);

    const key = makeUnifiedKey("procedure-skill", proc.id);
    const appliedEvent = ctx.changeFeed.append({
      sessionKey: "default",
      timestamp: Date.now(),
      tier: "persistent",
      category: "procedure-skill",
      action: "applied",
      title: "Procedure skill installed",
      detail: skillRelPath,
      proposalKey: key,
      rollbackAvailable: true,
      activation: "next-turn",
    });

    const result = revertChangeById(buildRevertCtx(ctx), appliedEvent.id);
    expect(result.ok).toBe(true);
    const updated = ctx.factsDb.getProcedureById(proc.id);
    expect(updated?.promotedToSkill).toBe(0);
    expect(updated?.skillState).toBe("uninstalled");
    expect(existsSync(skillAbsPath)).toBe(false);
    expect(ctx.changeFeed.getById(appliedEvent.id)?.status).toBe("reverted");
  });

  it("reverts an implemented tool proposal via workshopWithdrawTool", () => {
    const tool = ctx.toolProposalStore.create({
      name: "memory_lookup",
      description: "Lookup helper",
      parameters: "{}",
      rationale: "Gap detected",
      sourcePatterns: "[]",
      implementationHint: "Add tool",
    });
    ctx.toolProposalStore.updateStatus(tool.id, "approved", "proposed");
    ctx.toolProposalStore.updateStatus(tool.id, "implemented", "approved");
    const key = makeUnifiedKey("tool", tool.id);
    const appliedEvent = ctx.changeFeed.append({
      sessionKey: "default",
      timestamp: Date.now(),
      tier: "persistent",
      category: "tool",
      action: "applied",
      title: "Tool proposal implemented",
      detail: "Implemented",
      proposalKey: key,
      rollbackAvailable: true,
      activation: "next-turn",
    });

    const result = revertChangeById(buildRevertCtx(ctx), appliedEvent.id);
    expect(result.ok).toBe(true);
    expect(ctx.toolProposalStore.getById(tool.id)?.status).toBe("rejected");
    expect(ctx.changeFeed.getById(appliedEvent.id)?.status).toBe("reverted");
  });
});
