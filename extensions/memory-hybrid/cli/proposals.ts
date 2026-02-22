/**
 * CLI commands for managing persona proposals (human-only operations)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { Chainable } from "./shared.js";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { HybridMemoryConfig, IdentityFileType } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";

/** Resolve a proposal target file (e.g. SOUL.md) against the workspace directory. */
function resolveProposalTarget(targetFile: string): string {
  const workspace = process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
  return join(workspace, targetFile);
}
import { getFileSnapshot } from "../utils/file-snapshot.js";

export interface ProposalsCliContext {
  proposalsDb: ProposalsDB;
  cfg: HybridMemoryConfig;
  resolvedSqlitePath: string;
  api: ClawdbotPluginApi;
}

/**
 * Audit trail logging for proposal actions
 */
async function auditProposal(
  action: string,
  proposalId: string,
  resolvedSqlitePath: string,
  details?: any,
  logger?: { warn?: (msg: string) => void; error?: (msg: string) => void }
): Promise<void> {
  const auditDir = join(dirname(resolvedSqlitePath), "decisions");
  await mkdir(auditDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    action,
    proposalId,
    ...details,
  };
  const auditPath = join(auditDir, `proposal-${proposalId}.jsonl`);
  try {
    await writeFile(auditPath, JSON.stringify(entry) + "\n", { flag: "a" });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'proposals-audit',
      subsystem: 'proposals',
      proposalId,
    });
    const msg = `Audit log write failed: ${err}`;
    if (logger?.warn) {
      logger.warn(`memory-hybrid: ${msg}`);
    } else if (logger?.error) {
      logger.error(msg);
    }
  }
}

const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "applied"] as const;

function formatExpires(proposal: { expiresAt: number | null; createdAt: number }): string {
  if (!proposal.expiresAt) return "never";
  const now = Math.floor(Date.now() / 1000);
  const days = Math.max(0, Math.floor((proposal.expiresAt - now) / 86400));
  return `${days}d`;
}

type ProposalChangeType = "append" | "replace";

const REPLACE_PREFIXES = [
  /^replace the entire file\b/i,
  /^replace entire file\b/i,
  /^replace the whole file\b/i,
  /^replace whole file\b/i,
  /^replace the file\b/i,
];

export function parseSuggestedChange(suggestedChange: string): { changeType: ProposalChangeType; content: string } {
  const lines = suggestedChange.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? "";
  const replaceMatch = REPLACE_PREFIXES.find((re) => re.test(firstLine));
  if (replaceMatch) {
    const remainderMatch = firstLine.match(/^\s*replace(?:\s+the)?\s+(?:entire|whole)?\s*file\b\s*:?\s*(.*)$/i);
    const remainderRaw = remainderMatch?.[1] ? remainderMatch[1].trim() : "";
    const remainder = remainderRaw && !/^[.:]$/.test(remainderRaw) ? remainderRaw : "";
    let content = [remainder, ...lines.slice(1)].join("\n");
    content = content.replace(/^\s*(with|with the following|with the following content)\s*:\s*\n?/i, "");
    return { changeType: "replace", content };
  }
  return { changeType: "append", content: suggestedChange };
}

/**
 * Apply confidence cap for replace-type proposals (issue #89).
 * SOUL.md replace is capped at 0.5; other file replace at 0.6; append unchanged.
 */
export function capProposalConfidence(confidence: number, targetFile: string, suggestedChange: string): number {
  const parsed = parseSuggestedChange(suggestedChange);
  if (parsed.changeType === "replace" && targetFile === "SOUL.md") {
    return Math.min(confidence, 0.5);
  }
  if (parsed.changeType === "replace") {
    return Math.min(confidence, 0.6);
  }
  return confidence;
}

function buildAppendBlock(proposalId: string, observation: string, suggestedChange: string, timestamp: string): string {
  const escapeHtmlComment = (text: string): string =>
    text.replace(/-->/g, "-- >").replace(/<!--/g, "<! --");
  const safeObservation = escapeHtmlComment(observation);
  return `\n\n<!-- Proposal ${proposalId} applied at ${timestamp} -->\n<!-- Observation: ${safeObservation} -->\n\n${suggestedChange}\n`;
}

export function buildAppliedContent(
  original: string,
  proposal: { id: string; observation: string; suggestedChange: string },
  timestamp: string,
): { changeType: ProposalChangeType; content: string } {
  const parsed = parseSuggestedChange(proposal.suggestedChange);
  if (parsed.changeType === "replace") {
    return { changeType: "replace", content: parsed.content };
  }
  return {
    changeType: "append",
    content: original + buildAppendBlock(proposal.id, proposal.observation, parsed.content, timestamp),
  };
}

export function buildUnifiedDiff(currentContent: string, proposedContent: string, targetFile: string): string {
  const diffDir = mkdtempSync(join(tmpdir(), "proposal-diff-"));
  const currentPath = join(diffDir, "current.txt");
  const proposedPath = join(diffDir, "proposed.txt");
  try {
    writeFileSync(currentPath, currentContent, "utf-8");
    writeFileSync(proposedPath, proposedContent, "utf-8");
    const result = spawnSync(
      "git",
      ["diff", "--no-index", "--label", `${targetFile} (current)`, "--label", `${targetFile} (proposed)`, "--", currentPath, proposedPath],
      { encoding: "utf-8" },
    );
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(result.stderr || result.stdout || "git diff failed");
    }
    const out = (result.stdout || "").trimEnd();
    return out || "(no changes)";
  } finally {
    rmSync(diffDir, { recursive: true, force: true });
  }
}

/** Returns true if the given path (or its directory) is inside a git repository. */
function isGitRepo(dirOrFilePath: string): boolean {
  const dir = dirOrFilePath.endsWith("/") ? dirOrFilePath.slice(0, -1) : dirname(dirOrFilePath);
  const result = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf-8" });
  return result.status === 0 && !!result.stdout?.trim();
}

function commitProposalChange(
  targetPath: string,
  proposalId: string,
  targetFile: string,
): { ok: true } | { ok: false; error: string } {
  const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(targetPath), encoding: "utf-8" });
  if (repoRoot.status !== 0 || !repoRoot.stdout.trim()) {
    return { ok: false, error: `Failed to resolve git repo root: ${repoRoot.stderr || repoRoot.stdout}` };
  }
  const cwd = repoRoot.stdout.trim();
  const relPath = relative(cwd, targetPath);
  const add = spawnSync("git", ["add", "--", relPath], { cwd, encoding: "utf-8" });
  if (add.status !== 0) {
    return { ok: false, error: `git add failed: ${add.stderr || add.stdout}` };
  }
  const message = `chore: apply persona proposal ${proposalId} to ${targetFile}`;
  const commit = spawnSync("git", ["commit", "-m", message, "--", relPath], { cwd, encoding: "utf-8" });
  if (commit.status !== 0) {
    return { ok: false, error: `git commit failed: ${commit.stderr || commit.stdout}` };
  }
  return { ok: true };
}

/**
 * Register CLI commands for persona proposal management
 * NOTE: These are human-only commands and NOT exposed as agent-callable tools
 */
export function registerProposalsCli(program: Chainable, ctx: ProposalsCliContext): void {
  const proposals = program.command("proposals").description("Manage persona proposals (human-only commands)");

  proposals
    .command("show <proposalId>")
    .description("Show full proposal content (observation, suggested change, optional diff)")
    .option("--json", "Machine-readable output")
    .option("--diff", "Show unified diff against current target file")
    .action((proposalId: string, opts?: { json?: boolean; diff?: boolean }) => {
      const proposal = ctx.proposalsDb.get(proposalId);
      if (!proposal) {
        console.error(`Proposal ${proposalId} not found`);
        process.exit(1);
      }
      const targetPath = resolveProposalTarget(proposal.targetFile);
      const includeDiff = !!opts?.diff || !!opts?.json;
      let diffText: string | null = null;
      if (includeDiff && existsSync(targetPath)) {
        try {
          const current = readFileSync(targetPath, "utf-8");
          const proposed = buildAppliedContent(current, proposal, new Date().toISOString()).content;
          diffText = buildUnifiedDiff(current, proposed, proposal.targetFile);
        } catch (err) {
          diffText = null;
        }
      } else if (includeDiff) {
        try {
          const proposed = buildAppliedContent("", proposal, new Date().toISOString()).content;
          diffText = buildUnifiedDiff("", proposed, proposal.targetFile);
        } catch (err) {
          diffText = null;
        }
      }
      if (opts?.json) {
        console.log(JSON.stringify({ ...proposal, diff: diffText }, null, 2));
        return;
      }
      const created = new Date(proposal.createdAt * 1000).toISOString();
      const evidenceCount = Array.isArray(proposal.evidenceSessions) ? proposal.evidenceSessions.length : 0;
      console.log(`Proposal: ${proposal.id}`);
      console.log(`Status: ${proposal.status}`);
      console.log(`Target: ${proposal.targetFile}`);
      console.log(`Confidence: ${proposal.confidence.toFixed(2)}`);
      console.log(`Created: ${created} (expires in ${formatExpires(proposal)})`);
      console.log(`Evidence: ${evidenceCount} sessions`);
      console.log("");
      console.log("── Observation ──");
      console.log(proposal.observation);
      console.log("");
      console.log("── Suggested Change ──");
      console.log(proposal.suggestedChange);
      if (opts?.diff) {
        console.log("");
        console.log("── Preview (diff) ──");
        if (diffText) console.log(diffText);
        else console.log("(diff unavailable)");
      }
    });

  proposals
    .command("review <proposalId> <action>")
    .description("Approve or reject a persona proposal (action: approve|reject)")
    .option("--reviewed-by <name>", "Name/ID of reviewer")
    .action(async (proposalId: string, action: string, opts: { reviewedBy?: string }) => {
      if (action !== "approve" && action !== "reject") {
        console.error("Action must be 'approve' or 'reject'");
        process.exit(1);
      }

      const proposal = ctx.proposalsDb.get(proposalId);
      if (!proposal) {
        console.error(`Proposal ${proposalId} not found`);
        process.exit(1);
      }

      if (proposal.status !== "pending") {
        console.error(`Proposal ${proposalId} is already ${proposal.status}. Cannot review again.`);
        process.exit(1);
      }

      const newStatus = action === "approve" ? "approved" : "rejected";
      ctx.proposalsDb.updateStatus(proposalId, newStatus, opts.reviewedBy);

      await auditProposal(action, proposalId, ctx.resolvedSqlitePath, {
        reviewedBy: opts.reviewedBy ?? "cli-user",
        previousStatus: "pending",
        newStatus,
      }, { error: console.error });

      console.log(`Proposal ${proposalId} ${action}d.`);
      if (action === "approve") {
        const applyResult = await applyApprovedProposal(ctx, proposalId);
        if (applyResult.ok) {
          console.log(`Applied to ${applyResult.targetFile}. Backup: ${applyResult.backupPath}`);
        } else {
          console.error(`Apply failed: ${applyResult.error}. Proposal remains approved. Run 'openclaw hybrid-mem proposals apply ${proposalId}' after fixing.`);
        }
      }
    });

  proposals
    .command("apply <proposalId>")
    .description("Apply an approved persona proposal to its target identity file")
    .action(async (proposalId: string) => {
      const result = await applyApprovedProposal(ctx, proposalId);
      if (!result.ok) {
        console.error(result.error);
        process.exit(1);
      }
      console.log(`Proposal ${proposalId} applied to ${result.targetFile}`);
      if (result.backupPath) console.log(`Backup saved: ${result.backupPath}`);
      console.log(`\nChange:\n${result.suggestedChange}`);
    });
}

export type ApplyProposalContext = {
  proposalsDb: ProposalsDB;
  cfg: { personaProposals: { allowedFiles: string[] } };
  resolvedSqlitePath: string;
  api?: { logger?: { warn?: (msg: string) => void } };
};

/**
 * Apply an approved proposal to its target file and mark as applied.
 * Used by CLI "apply" and after "approve" so approval auto-applies (fixes #82).
 */
export async function applyApprovedProposal(
  ctx: ApplyProposalContext,
  proposalId: string,
): Promise<{ ok: true; targetFile: string; backupPath: string; suggestedChange: string } | { ok: false; error: string }> {
  const proposal = ctx.proposalsDb.get(proposalId);
  if (!proposal) {
    return { ok: false, error: `Proposal ${proposalId} not found` };
  }
  if (proposal.status !== "approved") {
    return { ok: false, error: `Proposal ${proposalId} is ${proposal.status}. Only approved proposals can be applied.` };
  }
  if (!ctx.cfg.personaProposals.allowedFiles.includes(proposal.targetFile as IdentityFileType)) {
    return {
      ok: false,
      error: `Target file ${proposal.targetFile} is no longer in allowedFiles. Current: ${ctx.cfg.personaProposals.allowedFiles.join(", ")}`,
    };
  }
  if (proposal.targetFile.includes("..") || proposal.targetFile.includes("/") || proposal.targetFile.includes("\\")) {
    return { ok: false, error: `Invalid target file path: ${proposal.targetFile}. Path traversal detected.` };
  }
  const targetPath = resolveProposalTarget(proposal.targetFile);
  if (!existsSync(targetPath)) {
    return { ok: false, error: `Target file ${proposal.targetFile} not found at ${targetPath}` };
  }
  const DANGEROUS_PATTERNS = /<script|<iframe|javascript:/i;
  if (DANGEROUS_PATTERNS.test(proposal.suggestedChange)) {
    return { ok: false, error: `Proposal ${proposalId} contains potentially dangerous content and cannot be applied.` };
  }
  try {
    const currentSnapshot = getFileSnapshot(targetPath);
    if (proposal.targetHash && currentSnapshot?.hash && proposal.targetHash !== currentSnapshot.hash) {
      return {
        ok: false,
        error: `Target file ${proposal.targetFile} has changed since proposal creation (hash mismatch). Review and re-approve.`,
      };
    }
    if (!proposal.targetHash && proposal.targetMtimeMs != null && currentSnapshot?.mtimeMs != null && proposal.targetMtimeMs !== currentSnapshot.mtimeMs) {
      return {
        ok: false,
        error: `Target file ${proposal.targetFile} has changed since proposal creation (mtime mismatch). Review and re-approve.`,
      };
    }
    const original = readFileSync(targetPath, "utf-8");
    const backupPath = `${targetPath}.backup-${Date.now()}`;
    writeFileSync(backupPath, original);
    const timestamp = new Date().toISOString();
    const applied = buildAppliedContent(original, proposal, timestamp);
    if (!applied.content.trim()) {
      return { ok: false, error: `Proposal ${proposalId} does not contain replacement content to apply.` };
    }
    writeFileSync(targetPath, applied.content);
    if (isGitRepo(targetPath)) {
      const commitResult = commitProposalChange(targetPath, proposalId, proposal.targetFile);
      if (!commitResult.ok) {
        ctx.api?.logger?.warn?.(
          `memory-hybrid: Git commit failed after applying proposal ${proposalId}; file was written successfully. ${commitResult.error}`,
        );
      }
    }
    ctx.proposalsDb.markApplied(proposalId);
    await auditProposal("applied", proposalId, ctx.resolvedSqlitePath, {
      targetFile: proposal.targetFile,
      targetPath,
      backupPath,
      timestamp,
      changeType: applied.changeType,
    }, { error: console.error });
    return {
      ok: true,
      targetFile: proposal.targetFile,
      backupPath,
      suggestedChange: proposal.suggestedChange,
    };
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "apply-proposal",
      subsystem: "proposals",
      proposalId,
    });
    return { ok: false, error: `Failed to apply proposal: ${err}` };
  }
}
