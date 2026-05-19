import { getEnv } from "../utils/env-manager.js";
/**
 * CLI commands for managing persona proposals (human-only operations)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { HybridMemoryConfig, IdentityFileType } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { spawnSync } from "../utils/process-runner.js";
/** Resolve a proposal target file (e.g. SOUL.md) against the workspace directory. */
function resolveProposalTarget(targetFile: string): string {
  const workspace = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
  return join(workspace, targetFile);
}
import { getFileSnapshot } from "../utils/file-snapshot.js";

/**
 * Audit trail logging for proposal actions
 */
async function auditProposal(
  action: string,
  proposalId: string,
  resolvedSqlitePath: string,
  details?: any,
  logger?: { warn?: (msg: string) => void; error?: (msg: string) => void },
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
    await writeFile(auditPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "proposals-audit",
      subsystem: "proposals",
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

type ProposalChangeType = "append" | "replace";

const REPLACE_PREFIXES = [
  "replace the entire file",
  "replace entire file",
  "replace the whole file",
  "replace whole file",
  "replace the file",
] as const;

function stripOneLeadingSeparator(input: string): string {
  let out = input.trimStart();
  if (out.startsWith(":") || out.startsWith(".")) out = out.slice(1);
  return out.trimStart();
}

function stripReplaceContentLeadIn(input: string): string {
  const trimmed = input.trimStart();
  const lower = trimmed.toLowerCase();
  for (const leadIn of ["with the following content", "with the following", "with"] as const) {
    if (lower === leadIn) return "";
    if (lower.startsWith(leadIn)) {
      const afterLeadIn = trimmed.slice(leadIn.length);
      const trimmedAfter = afterLeadIn.trimStart();
      if (trimmedAfter.startsWith(":")) {
        const afterColon = trimmedAfter.slice(1);
        const afterColonTrimmed = afterColon.trimStart();
        if (
          afterColonTrimmed === "" ||
          afterColon.startsWith("\n") ||
          afterColon.startsWith("\r") ||
          afterColon.startsWith(" \n") ||
          afterColon.startsWith(" \r")
        ) {
          return stripOneLeadingSeparator(afterLeadIn);
        }
      }
    }
  }
  return input;
}

export function parseSuggestedChange(suggestedChange: string): { changeType: ProposalChangeType; content: string } {
  const lines = suggestedChange.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? "";
  const lowerFirstLine = firstLine.toLowerCase();
  const replacePrefix = REPLACE_PREFIXES.find((prefix) => {
    if (lowerFirstLine === prefix) return true;
    if (lowerFirstLine.startsWith(`${prefix}:`)) return true;
    if (lowerFirstLine.startsWith(`${prefix}.`)) return true;
    if (lowerFirstLine.startsWith(`${prefix} `)) return true;
    return false;
  });
  if (replacePrefix) {
    const remainder = stripOneLeadingSeparator(firstLine.slice(replacePrefix.length));
    const content = stripReplaceContentLeadIn([remainder, ...lines.slice(1)].join("\n"));
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
    text
      // Neutralize both standard (-->) and lenient (--!>) HTML comment end markers.
      .replace(/--!?>/g, "-- >")
      // Prevent starting a new HTML comment inside the observation.
      .replace(/<!--/g, "<! --");
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
      [
        "diff",
        "--no-index",
        "--label",
        `${targetFile} (current)`,
        "--label",
        `${targetFile} (proposed)`,
        "--",
        currentPath,
        proposedPath,
      ],
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
  let dir: string;
  try {
    dir = statSync(dirOrFilePath).isDirectory() ? dirOrFilePath : dirname(dirOrFilePath);
  } catch {
    dir = dirname(dirOrFilePath);
  }
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

type ApplyProposalContext = {
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
): Promise<
  { ok: true; targetFile: string; backupPath: string; suggestedChange: string } | { ok: false; error: string }
> {
  const proposal = ctx.proposalsDb.get(proposalId);
  if (!proposal) {
    return { ok: false, error: `Proposal ${proposalId} not found` };
  }
  if (proposal.status !== "approved") {
    return {
      ok: false,
      error: `Proposal ${proposalId} is ${proposal.status}. Only approved proposals can be applied.`,
    };
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
    if (
      !proposal.targetHash &&
      proposal.targetMtimeMs != null &&
      currentSnapshot?.mtimeMs != null &&
      proposal.targetMtimeMs !== currentSnapshot.mtimeMs
    ) {
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
    // Only attempt git commit when the target is inside a git repo (issue #90: non-git workspace can still apply).
    if (isGitRepo(targetPath)) {
      const commitResult = commitProposalChange(targetPath, proposalId, proposal.targetFile);
      if (!commitResult.ok) {
        writeFileSync(targetPath, original);
        const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" });
        if (repoRoot.status === 0 && repoRoot.stdout.trim()) {
          const cwd = repoRoot.stdout.trim();
          const relPath = relative(cwd, targetPath);
          spawnSync("git", ["reset", "HEAD", "--", relPath], { cwd, encoding: "utf-8" });
        }
        return {
          ok: false,
          error: `Git commit failed; target file rolled back to original. Commit error: ${commitResult.error}`,
        };
      }
    }
    ctx.proposalsDb.markApplied(proposalId);
    await auditProposal(
      "applied",
      proposalId,
      ctx.resolvedSqlitePath,
      {
        targetFile: proposal.targetFile,
        targetPath,
        backupPath,
        timestamp,
        changeType: applied.changeType,
      },
      { error: console.error },
    );
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
