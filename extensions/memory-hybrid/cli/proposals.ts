import { getEnv } from "../utils/env-manager.js";
/**
 * CLI commands for managing persona proposals (human-only operations)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { ProposalEntry, ProposalsDB } from "../backends/proposals-db.js";
import type { IdentityFileType, HybridMemoryConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { emitPersonaApplied, supersedeActiveProposedEvent } from "../services/change-feed-emit.js";
import type { ChangeFeed } from "../services/change-feed.js";
import {
  type PersonaProposalAssessment,
  classifyAuthorityBucket,
  findCrossFileContentMatch,
  createDisabledRoutingPassthroughAssessment,
  resolvePersonaRuleRoutingConfig,
  routePersonaProposal,
  shouldBlockProposalCreation,
} from "../services/persona-rule-router.js";
import type { EmbeddingProvider } from "../services/embeddings/types.js";
import { writeProposalRollback, deleteProposalRollback } from "../services/proposal-rollback.js";
import {
  enforceMaxPendingCap,
  resolveWorkshopMaxPending,
  type UnifiedProposalStores,
} from "../services/unified-proposals.js";
import { resolveWorkshopAppliedSessionKey } from "../services/workshop-config.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { nowIso } from "../utils/dates.js";
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
  const timestamp = nowIso();
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

export type ProposalContentValidationFailure = "dangerous_content" | "prompt_injection" | "secret_or_private_data";

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
  title?: string;
  observation?: string;
  suggestedChange: string;
  allowedFiles: readonly string[];
  workspaceRoot: string;
  confidence: number;
  proposalTTLDays: number;
  minConfidence?: number;
  nowSec?: number;
  proposalsDb?: ProposalsDB;
  factsDb?: FactsDB | null;
  embeddings?: EmbeddingProvider | null;
  personaRuleRouting?: HybridMemoryConfig["personaProposals"]["personaRuleRouting"];
  evidenceSessions?: string[];
  /** When set, block pipeline proposal creation when the unified workshop queue is full. */
  workshopStores?: UnifiedProposalStores;
  maxPending?: number;
  /** Populated when routing assessment runs (for callers/logging). */
  routingAssessment?: PersonaProposalAssessment;
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
  const routing = resolvePersonaRuleRoutingConfig({ personaRuleRouting: input.personaRuleRouting });
  if (routing.enabled) {
    const syncAssessment = assessPersonaProposalRoutingSync({
      targetFile,
      title: input.title ?? "Pipeline proposal",
      observation: input.observation ?? "",
      suggestedChange: input.suggestedChange,
      confidence: input.confidence,
      evidenceSessions: input.evidenceSessions ?? [],
      workspaceRoot: input.workspaceRoot,
      allowedFiles: input.allowedFiles,
      personaRuleRouting: input.personaRuleRouting,
    });
    input.routingAssessment = syncAssessment;
    if (shouldBlockProposalCreation(syncAssessment, routing.routingMode)) return null;
  }
  if (input.proposalsDb) {
    const duplicate = input.proposalsDb.findPendingOrAppliedDuplicate(targetFile, input.suggestedChange);
    if (duplicate) return null;
  }
  if (input.workshopStores) {
    const cap = enforceMaxPendingCap(
      input.workshopStores,
      input.maxPending ?? resolveWorkshopMaxPending(input.workshopStores.cfg),
    );
    if (!cap.ok) return null;
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

export type AssessPersonaProposalRoutingInput = {
  targetFile: string;
  title: string;
  observation: string;
  suggestedChange: string;
  confidence: number;
  evidenceSessions: string[];
  workspaceRoot: string;
  allowedFiles: readonly string[];
  factsDb?: FactsDB | null;
  embeddings?: EmbeddingProvider | null;
  personaRuleRouting?: HybridMemoryConfig["personaProposals"]["personaRuleRouting"];
  adjudicateContradiction?: RoutePersonaProposalInput["adjudicateContradiction"];
};

type RoutePersonaProposalInput = Parameters<typeof routePersonaProposal>[0];

/** Sync keyword routing + cross-file content checks (no embeddings). */
export function assessPersonaProposalRoutingSync(
  input: Omit<AssessPersonaProposalRoutingInput, "factsDb" | "embeddings" | "adjudicateContradiction">,
): PersonaProposalAssessment {
  const routing = resolvePersonaRuleRoutingConfig({ personaRuleRouting: input.personaRuleRouting });
  const crossFileMatch = findCrossFileContentMatch({
    suggestedChange: input.suggestedChange,
    workspaceRoot: input.workspaceRoot,
    excludeFile: input.targetFile,
  });
  const body = `${input.title}\n${input.observation}\n${input.suggestedChange}`;
  const classification = classifyAuthorityBucket(body);
  const supportScore = computeSupportScoreForRouting(input);
  const mutationRisk = computeMutationRiskForRouting(input.targetFile, input.suggestedChange);

  let blockReason: PersonaProposalAssessment["blockReason"];
  let blockCandidate: PersonaProposalAssessment["blockCandidate"];
  const evidence: PersonaProposalAssessment["evidence"] = [];
  if (crossFileMatch) {
    blockReason = "already-in-file";
    blockCandidate = {
      source: "file-section",
      location: crossFileMatch.file,
      snippet: crossFileMatch.snippet,
      similarity: 1,
    };
    evidence.push({
      type: "file-section",
      location: crossFileMatch.file,
      snippet: crossFileMatch.snippet,
      summary: `Content already present in ${crossFileMatch.file}.`,
    });
  }

  const recommendedTargetFile = classification.bucket;
  const routingDisagrees =
    recommendedTargetFile !== "skill_workshop" &&
    recommendedTargetFile !== "memory_fact" &&
    recommendedTargetFile !== input.targetFile;

  let routingSuggestion: PersonaProposalAssessment["routingSuggestion"];
  const routingConfident = classification.routingScore >= 0.7;
  if (routingDisagrees && routingConfident) {
    routingSuggestion = {
      recommendedTargetFile: String(recommendedTargetFile),
      rationale: classification.rationale,
      callerTargetFile: input.targetFile,
    };
  } else if (routingDisagrees) {
    routingSuggestion = {
      recommendedTargetFile: String(recommendedTargetFile),
      rationale: `${classification.rationale} (low routing confidence ${classification.routingScore.toFixed(2)}; advisory only)`,
      callerTargetFile: input.targetFile,
    };
  }

  let overallDisposition: PersonaProposalAssessment["overallDisposition"] = blockReason ? "reject" : "propose";
  if (routingDisagrees && routingConfident && !blockReason) overallDisposition = "retarget";
  if (supportScore < 0.55) {
    overallDisposition = "reject";
    blockReason = blockReason ?? "low-support";
  }
  if (routing.routingMode === "enforce" && routingDisagrees && routingConfident && !blockReason) {
    blockReason = "enforce-routing";
  }

  return {
    supportScore,
    routingScore: classification.routingScore,
    dedupScore: crossFileMatch ? 1 : 0,
    contradictionRisk: 0,
    mutationRisk,
    llmConfidenceHint: input.confidence,
    overallDisposition,
    recommendedTargetFile,
    routingRationale: classification.rationale,
    routingSuggestion,
    dedupCandidates: [],
    contradictionCandidates: [],
    evidence,
    humanReviewRequired: Boolean((routingDisagrees && routingConfident) || blockReason),
    applyAllowed: !blockReason,
    contradiction: false,
    blockReason,
    blockCandidate,
  };
}

export async function assessPersonaProposalRouting(
  input: AssessPersonaProposalRoutingInput,
): Promise<PersonaProposalAssessment> {
  const routing = resolvePersonaRuleRoutingConfig({ personaRuleRouting: input.personaRuleRouting });
  if (!routing.enabled) {
    return createDisabledRoutingPassthroughAssessment({
      targetFile: input.targetFile,
      confidence: input.confidence,
      suggestedChange: input.suggestedChange,
    });
  }
  return routePersonaProposal({
    targetFile: input.targetFile,
    title: input.title,
    observation: input.observation,
    suggestedChange: input.suggestedChange,
    confidence: input.confidence,
    evidenceSessions: input.evidenceSessions,
    workspaceRoot: input.workspaceRoot,
    allowedFiles: input.allowedFiles,
    routing,
    factsDb: input.factsDb,
    embedText: input.embeddings ? (text) => input.embeddings!.embed(text) : undefined,
    adjudicateContradiction: input.adjudicateContradiction,
  });
}

function computeSupportScoreForRouting(input: {
  confidence: number;
  evidenceSessions: string[];
  observation: string;
}): number {
  const evidenceBoost = Math.min(0.25, Math.max(0, input.evidenceSessions.length - 1) * 0.05);
  const base = Math.max(0, Math.min(1, input.confidence));
  return Math.min(1, base * 0.85 + evidenceBoost + (input.observation.trim().length > 40 ? 0.05 : 0));
}

function computeMutationRiskForRouting(targetFile: string, suggestedChange: string): number {
  if (targetFile === "SOUL.md" || targetFile === "IDENTITY.md") return 0.85;
  if (targetFile === "USER.md") return 0.7;
  if (/^\s*replace\b/i.test(suggestedChange)) return 0.8;
  if (targetFile === "AGENTS.md" || targetFile === "TOOLS.md") return 0.45;
  return 0.55;
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
  cfg: Pick<HybridMemoryConfig, "personaProposals" | "liveChangeFeed">;
  resolvedSqlitePath: string;
  api?: { logger?: { warn?: (msg: string) => void } };
  changeFeed?: ChangeFeed | null;
  sessionKey?: string;
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
  let original = "";
  let wroteRollback = false;
  let wroteFile = false;
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
    original = readFileSync(targetPath, "utf-8");
    const originalSnapshot = getFileSnapshot(targetPath);
    const backupPath = `${targetPath}.backup-${Date.now()}`;
    writeFileSync(backupPath, original);
    const timestamp = nowIso();
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
        appliedHash: createHash("sha256").update(applied.content).digest("hex"),
        appliedAt: timestamp,
        changeType: applied.changeType,
      });
      wroteRollback = true;
    }
    atomicWriteFile(targetPath, applied.content);
    wroteFile = true;
    // Only attempt git commit when the target is inside a git repo (issue #90: non-git workspace can still apply).
    if (isGitRepo(targetPath)) {
      const commitResult = commitProposalChange(targetPath, proposalId, proposal.targetFile);
      if (!commitResult.ok) {
        atomicWriteFile(targetPath, original);
        if (wroteRollback) deleteProposalRollback(ctx.resolvedSqlitePath, proposalId);
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
    const marked = ctx.proposalsDb.markAppliedIfApproved(proposalId);
    if (!marked) {
      if (wroteFile) atomicWriteFile(targetPath, original);
      if (wroteRollback) deleteProposalRollback(ctx.resolvedSqlitePath, proposalId);
      return { ok: false, error: `Proposal ${proposalId} is no longer approved` };
    }
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
    emitPersonaApplied(ctx.changeFeed, ctx.cfg as HybridMemoryConfig, {
      sessionKey: ctx.sessionKey ?? resolveWorkshopAppliedSessionKey(ctx.cfg as HybridMemoryConfig),
      proposalId,
      targetFile: proposal.targetFile,
      title: proposal.title,
      rollbackAvailable: wroteRollback,
    });
    supersedeActiveProposedEvent(ctx.changeFeed, `persona:${proposalId}`);
    return {
      ok: true,
      targetFile: proposal.targetFile,
      backupPath,
      suggestedChange: proposal.suggestedChange,
    };
  } catch (err) {
    if (wroteFile && original) {
      try {
        atomicWriteFile(targetPath, original);
      } catch {
        // Best-effort restore only.
      }
    }
    if (wroteRollback) deleteProposalRollback(ctx.resolvedSqlitePath, proposalId);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "apply-proposal",
      subsystem: "proposals",
      proposalId,
    });
    return { ok: false, error: `Failed to apply proposal: ${err}` };
  }
}
