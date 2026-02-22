/**
 * Tests for persona proposals: parseSuggestedChange, buildAppliedContent,
 * and applyApprovedProposal (including non-git workspace — issue #90).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSuggestedChange, buildAppliedContent, capProposalConfidence, applyApprovedProposal } from "../cli/proposals.js";
import { ProposalsDB } from "../backends/proposals-db.js";

describe("parseSuggestedChange", () => {
  it("returns append when text does not start with replace phrase", () => {
    const result = parseSuggestedChange("Add a new section:\n\n## Values\n- Kindness");
    expect(result.changeType).toBe("append");
    expect(result.content).toBe("Add a new section:\n\n## Values\n- Kindness");
  });

  it("returns replace when first line is 'Replace the entire file with the following:'", () => {
    const result = parseSuggestedChange("Replace the entire file with the following:\n\n# New SOUL\nBe kind.");
    expect(result.changeType).toBe("replace");
    expect(result.content).toContain("# New SOUL");
    expect(result.content).toContain("Be kind.");
  });

  it("returns replace for 'Replace entire file' variant", () => {
    const result = parseSuggestedChange("Replace entire file\n\nNew content");
    expect(result.changeType).toBe("replace");
    expect(result.content.trim()).toBe("New content");
  });

  it("returns append for content without replace prefix", () => {
    const result = parseSuggestedChange("## New section\nSome text");
    expect(result.changeType).toBe("append");
  });
});

describe("buildAppliedContent", () => {
  it("append: prepends original and adds proposal block", () => {
    const original = "# SOUL\nBe helpful.";
    const proposal = {
      id: "prop-1",
      observation: "User values clarity",
      suggestedChange: "## Clarity\nPrefer short sentences.",
    };
    const { changeType, content } = buildAppliedContent(original, proposal, "2026-02-22T12:00:00.000Z");
    expect(changeType).toBe("append");
    expect(content).toContain(original);
    expect(content).toContain("Proposal prop-1 applied");
    expect(content).toContain("## Clarity");
    expect(content).toContain("Prefer short sentences.");
  });

  it("replace: returns only new content", () => {
    const original = "# Old SOUL\nOld content";
    const proposal = {
      id: "prop-2",
      observation: "Full rewrite",
      suggestedChange: "Replace the entire file with the following:\n\n# New SOUL\nNew content only",
    };
    const { changeType, content } = buildAppliedContent(original, proposal, "2026-02-22T12:00:00.000Z");
    expect(changeType).toBe("replace");
    expect(content).not.toContain("Old content");
    expect(content).toContain("New content only");
  });
});

describe("capProposalConfidence (issue #89)", () => {
  it("caps SOUL.md replace at 0.5", () => {
    expect(capProposalConfidence(1.0, "SOUL.md", "Replace the entire file with the following:\n\n# New")).toBe(0.5);
    expect(capProposalConfidence(0.7, "SOUL.md", "Replace entire file\n\nX")).toBe(0.5);
    expect(capProposalConfidence(0.3, "SOUL.md", "Replace the entire file\n\nX")).toBe(0.3);
  });

  it("caps other file replace at 0.6, leaves append unchanged", () => {
    expect(capProposalConfidence(1.0, "USER.md", "Replace the entire file with the following:\n\n# User")).toBe(0.6);
    expect(capProposalConfidence(0.8, "IDENTITY.md", "Replace entire file\n\nY")).toBe(0.6);
    expect(capProposalConfidence(0.9, "SOUL.md", "## Append section\nNew text")).toBe(0.9);
  });
});

describe("applyApprovedProposal (non-git workspace — issue #90)", () => {
  let tmpDir: string;
  let proposalsDb: ProposalsDB;
  let originalWorkspace: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposals-apply-"));
    originalWorkspace = process.env.OPENCLAW_WORKSPACE;
    process.env.OPENCLAW_WORKSPACE = tmpDir;

    const targetFile = join(tmpDir, "SOUL.md");
    writeFileSync(targetFile, "# SOUL\nInitial content.\n", "utf-8");

    const dbPath = join(tmpDir, "proposals.db");
    proposalsDb = new ProposalsDB(dbPath);

    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Add clarity",
      observation: "Test observation",
      suggestedChange: "## Clarity\nPrefer short sentences.",
      confidence: 0.8,
      evidenceSessions: ["test"],
      expiresAt: null,
    });
    proposalsDb.updateStatus(proposal.id, "approved");
  });

  afterEach(() => {
    proposalsDb.close();
    if (originalWorkspace !== undefined) {
      process.env.OPENCLAW_WORKSPACE = originalWorkspace;
    } else {
      delete process.env.OPENCLAW_WORKSPACE;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes file and marks proposal applied when workspace is not a git repo", async () => {
    const proposal = proposalsDb.list({ status: "approved" })[0];
    const ctx = {
      proposalsDb,
      cfg: {
        personaProposals: { allowedFiles: ["SOUL.md", "USER.md", "IDENTITY.md"] },
      },
      resolvedSqlitePath: join(tmpDir, "memory.db"),
      api: { logger: { warn: () => {} } },
    };

    const result = await applyApprovedProposal(ctx, proposal.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetFile).toBe("SOUL.md");
      expect(result.backupPath).toBeTruthy();
    }

    const updated = proposalsDb.get(proposal.id);
    expect(updated?.status).toBe("applied");

    const targetPath = join(tmpDir, "SOUL.md");
    expect(existsSync(targetPath)).toBe(true);
    const content = readFileSync(targetPath, "utf-8");
    expect(content).toContain("Initial content.");
    expect(content).toContain("## Clarity");
    expect(content).toContain("Prefer short sentences.");
  });
});
