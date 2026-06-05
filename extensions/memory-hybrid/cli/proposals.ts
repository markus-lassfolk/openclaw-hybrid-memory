import { getEnv } from "../utils/env-manager.js";
/**
 * CLI commands for managing persona proposals (human-only operations)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { ProposalEntry, ProposalsDB } from "../backends/proposals-db.js";
import type { IdentityFileType } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { writeProposalRollback } from "../services/proposal-rollback.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
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

const PROPOSAL_DANGEROUS_CONTENT_RE = /<script|<iframe|javascript:/i;
const PROPOSAL_PROMPT_INJECTION_RE =
  /ignore (all )?(previous|above|system|developer)(?:\s+\w+){0,3}\s+instructions|reveal (the )?(system prompt|secrets)|bypass (policy|approval|safety)|you are now|act as an unrestricted/i;
const PROPOSAL_SECRET_OR_PRIVATE_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|token|password|secret)\s*[:=]|\bghp_[A-Za-z0-9_]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}/i;

export type ProposalContentValidationFailure =
  | "dangerous_content"
  | "prompt_injection"
  | "secret_or_private_data";

export function validateProposalContent(
  text: string,
): { ok: true } | { ok: false; reason: ProposalContentValidationFailure } {
  if (PROPOSAL_DANGEROUS_CONTENT_RE.test(text)) return { ok: false, reason: "dangerous_content" };
  if (PROPOSAL_SECRET_OR_PRIVATE_RE.test(text)) return { ok: false, reason: "secret_or_private_data" };
  if (PROPOSAL_PROMPT_INJECTION_RE.test(text)) return { ok: false, reason: "prompt_injection" };
  return { ok: true };
}

export function normalizeProposalText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Returns an existing pending/applied proposal with the same normalized change for the same target file. */
export function findDuplicateProposal(
  all: ProposalEntry[],
  candidate: Pick<ProposalEntry, "targetFile" | "suggestedChange"> & { id?: string },
): ProposalEntry | null {
  const normalized = normalizeProposalText(candidate.suggestedChange);
  if (!normalized) return null;
  return (
    all.find(
      (c) =>
        c.id !== candidate.id &&
        c.targetFile === candidate.targetFile &&
        (c.status === "applied" || c.status === "pending") &&
        normalizeProposalText(c.suggestedChange) === normalized,
    ) ?? null
  );
}

export function getProposalExpiryError(
  proposal: Pick<ProposalEntry, "expiresAt" | "id">,
  nowSec?: number,
): string | null {
  if (proposal.expiresAt == null) return null;
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (proposal.expiresAt >= now) return null;
  return `Proposal ${proposal.id} expired and cannot be approved or applied`;
}

/** Snapshot + validation helpers for pipeline-created proposals (self-correction, reinforcement, generate-proposals). */
export function resolvePipelineProposalTarget(input: {
  targetFile: string;
  suggestedChange: string;
  allowedFiles: readonly string[];
  workspaceRoot: string;
  confidence: number;
  proposalTTLDays: number;
  minConfidence?: number;
  nowSec?: number;
  proposalsDb?: ProposalsDB;
}): {
  targetFile: string;
  confidence: number;
  targetMtimeMs: number | null;
  targetHash: string | null;
  expiresAt: number | null;
} | null {
  const targetFile = input.targetFile.trim();
  if (!targetFile || !input.allowedFiles.includes(targetFile as IdentityFileType)) return null;
  const contentCheck = validateProposalContent(input.suggestedChange);
  if (!contentCheck.ok) return null;
  if (input.proposalsDb) {
    const duplicate = findDuplicateProposal(input.proposalsDb.list(), {
      targetFile,
      suggestedChange: input.suggestedChange,
    });
    if (duplicate) return null;
  }
  const snapshot = getFileSnapshot(join(input.workspaceRoot, targetFile));
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const confidence = capProposalConfidence(input.confidence, targetFile, input.suggestedChange);
  if (input.minConfidence != null && confidence < input.minConfidence) return null;
  return {
    targetFile,
    confidence,
    targetMtimeMs: snapshot?.mtimeMs ?? null,
    targetHash: snapshot?.hash ?? null,
    expiresAt: input.proposalTTLDays > 0 ? nowSec + input.proposalTTLDays * 24 * 3600 : null,
  };
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
  const expiryError = getProposalExpiryError(proposal);
  if (expiryError) {
    return { ok: false, error: expiryError };
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
  const contentCheck = validateProposalContent(
    `${proposal.title}\n${proposal.observation}\n${proposal.suggestedChange}`,
  );
  if (!contentCheck.ok) {
    return {
      ok: false,
      error: `Proposal ${proposalId} failed safety validation (${contentCheck.reason}) and cannot be applied.`,
    };
  }
  const parsedChange = parseSuggestedChange(proposal.suggestedChange);
  if (parsedChange.changeType === "replace" && !proposal.targetHash && proposal.targetMtimeMs == null) {
    return {
      ok: false,
      error: `Proposal ${proposalId} is a full-file replace but has no target snapshot. Review and re-create the proposal.`,
    };
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
    const originalSnapshot = getFileSnapshot(targetPath);
    const backupPath = `${targetPath}.backup-${Date.now()}`;
    writeFileSync(backupPath, original);
    const timestamp = new Date().toISOString();
    const applied = buildAppliedContent(original, proposal, timestamp);
    if (!applied.content.trim()) {
      return { ok: false, error: `Proposal ${proposalId} does not contain replacement content to apply.` };
    }
    if (originalSnapshot) {
      writeProposalRollback(ctx.resolvedSqlitePath, {
        proposalId,
        proposalType: "persona",
        targetPath,
        originalHash: originalSnapshot.hash,
        originalContent: original,
        appliedAt: timestamp,
        changeType: applied.changeType,
      });
    }
    atomicWriteFile(targetPath, applied.content);
    // Only attempt git commit when the target is inside a git repo (issue #90: non-git workspace can still apply).
    if (isGitRepo(targetPath)) {
      const commitResult = commitProposalChange(targetPath, proposalId, proposal.targetFile);
      if (!commitResult.ok) {
        atomicWriteFile(targetPath, original);
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
