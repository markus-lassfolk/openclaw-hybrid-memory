import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProposalsDB } from "../backends/proposals-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { _testing } from "../index.js";
import { makeUnifiedKey } from "../services/unified-proposals.js";
import { workshopRevise, workshopUndo } from "../services/workshop-service.js";
import { writeProposalRollback } from "../services/proposal-rollback.js";
import { setEnv } from "../utils/env-manager.js";

const { FactsDB } = _testing;

describe("workshopRevise persona proposals", () => {
  let tmpDir: string;
  let proposalsDb: ProposalsDB;
  let factsDb: InstanceType<typeof FactsDB>;
  let originalWorkspace: string | undefined;
  let cfg: HybridMemoryConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "workshop-revise-"));
    originalWorkspace = process.env.OPENCLAW_WORKSPACE;
    setEnv("OPENCLAW_WORKSPACE", tmpDir);
    writeFileSync(join(tmpDir, "SOUL.md"), "# SOUL\nInitial.\n", "utf-8");
    proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
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
    } as HybridMemoryConfig;
  });

  afterEach(() => {
    proposalsDb.close();
    factsDb.close();
    if (originalWorkspace !== undefined) {
      setEnv("OPENCLAW_WORKSPACE", originalWorkspace);
    } else {
      setEnv("OPENCLAW_WORKSPACE", undefined);
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refreshes target snapshot and rejects unsafe revisions", async () => {
    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Add guidance",
      observation: "Observed pattern",
      suggestedChange: "Prefer concise replies.",
      confidence: 0.9,
      evidenceSessions: ["session-1"],
      targetHash: "old-hash",
      targetMtimeMs: 1,
    });
    const key = makeUnifiedKey("persona", proposal.id);
    const ctx = {
      cfg,
      factsDb,
      proposalsDb,
      crystallizationStore: null,
      toolProposalStore: null,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
    };

    const unsafe = workshopRevise(ctx, key, "<script>alert(1)</script>");
    expect(unsafe.ok).toBe(false);

    const ok = workshopRevise(ctx, key, "Prefer concise, evidence-backed replies.");
    expect(ok.ok).toBe(true);
    const updated = proposalsDb.get(proposal.id);
    expect(updated?.suggestedChange).toBe("Prefer concise, evidence-backed replies.");
    expect(updated?.targetHash).toBeTruthy();
    expect(updated?.targetHash).not.toBe("old-hash");
    expect(updated?.targetMtimeMs).not.toBe(1);
  });
});

describe("workshopUndo persona proposals", () => {
  let tmpDir: string;
  let proposalsDb: ProposalsDB;
  let factsDb: InstanceType<typeof FactsDB>;
  let originalWorkspace: string | undefined;
  let cfg: HybridMemoryConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "workshop-undo-"));
    originalWorkspace = process.env.OPENCLAW_WORKSPACE;
    setEnv("OPENCLAW_WORKSPACE", tmpDir);
    writeFileSync(join(tmpDir, "SOUL.md"), "# SOUL\nInitial.\n", "utf-8");
    proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
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
    } as HybridMemoryConfig;
  });

  afterEach(() => {
    proposalsDb.close();
    factsDb.close();
    if (originalWorkspace !== undefined) setEnv("OPENCLAW_WORKSPACE", originalWorkspace);
    else setEnv("OPENCLAW_WORKSPACE", undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("claims applied status before restoring file and reverts DB claim on file failure", () => {
    const original = readFileSync(join(tmpDir, "SOUL.md"), "utf-8");
    const applied = "# SOUL\nInitial.\n\nApplied guidance.\n";
    writeFileSync(join(tmpDir, "SOUL.md"), applied, "utf-8");
    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Undo test",
      observation: "obs",
      suggestedChange: "Applied guidance.",
      confidence: 0.9,
      evidenceSessions: [],
    });
    proposalsDb.updateStatusIf(proposal.id, "approved", "pending");
    proposalsDb.markAppliedIfApproved(proposal.id);
    writeProposalRollback(join(tmpDir, "facts.db"), {
      proposalId: proposal.id,
      proposalType: "persona",
      targetPath: join(tmpDir, "SOUL.md"),
      originalHash: createHash("sha256").update(original).digest("hex"),
      originalContent: original,
      appliedHash: createHash("sha256").update(applied).digest("hex"),
      appliedAt: new Date().toISOString(),
    });
    writeFileSync(join(tmpDir, "SOUL.md"), "# Manual edit\n", "utf-8");

    const key = makeUnifiedKey("persona", proposal.id);
    const result = workshopUndo(
      {
        cfg,
        factsDb,
        proposalsDb,
        crystallizationStore: null,
        toolProposalStore: null,
        resolvedSqlitePath: join(tmpDir, "facts.db"),
      },
      key,
    );

    expect(result.ok).toBe(false);
    expect(proposalsDb.get(proposal.id)?.status).toBe("applied");
    expect(readFileSync(join(tmpDir, "SOUL.md"), "utf-8")).toBe("# Manual edit\n");
  });
});
