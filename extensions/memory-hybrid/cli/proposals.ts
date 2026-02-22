/**
 * CLI commands for managing persona proposals (human-only operations)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Chainable } from "./shared.js";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { HybridMemoryConfig, IdentityFileType } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";

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
      if (opts?.json) {
        console.log(JSON.stringify(proposal, null, 2));
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
        const targetPath = ctx.api.resolvePath(proposal.targetFile);
        console.log("");
        console.log("── Preview (diff) ──");
        if (existsSync(targetPath)) {
          const current = readFileSync(targetPath, "utf-8");
          console.log(`--- ${proposal.targetFile} (current)`);
          console.log(`+++ ${proposal.targetFile} (with suggestion)`);
          for (const line of current.split(/\n/)) {
            console.log(`  ${line}`);
          }
          for (const line of proposal.suggestedChange.split(/\n/)) {
            console.log(`+ ${line}`);
          }
        } else {
          console.log("(target file not found; showing suggested content as addition)");
          for (const line of proposal.suggestedChange.split(/\n/)) {
            console.log(`+ ${line}`);
          }
        }
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
          console.error(`Apply failed: ${applyResult.error}. You can run 'openclaw hybrid-mem proposals apply ${proposalId}' after fixing.`);
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

export type ApplyProposalContext = Pick<ProposalsCliContext, "proposalsDb" | "cfg" | "resolvedSqlitePath" | "api">;

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
  const targetPath = ctx.api.resolvePath(proposal.targetFile);
  if (!existsSync(targetPath)) {
    return { ok: false, error: `Target file ${proposal.targetFile} not found at ${targetPath}` };
  }
  const DANGEROUS_PATTERNS = /<script|<iframe|javascript:/i;
  if (DANGEROUS_PATTERNS.test(proposal.suggestedChange)) {
    return { ok: false, error: `Proposal ${proposalId} contains potentially dangerous content and cannot be applied.` };
  }
  try {
    const original = readFileSync(targetPath, "utf-8");
    const backupPath = `${targetPath}.backup-${Date.now()}`;
    writeFileSync(backupPath, original);
    const escapeHtmlComment = (text: string): string =>
      text.replace(/-->/g, "-- >").replace(/<!--/g, "<! --");
    const timestamp = new Date().toISOString();
    const safeObservation = escapeHtmlComment(proposal.observation);
    const changeBlock = `\n\n<!-- Proposal ${proposalId} applied at ${timestamp} -->\n<!-- Observation: ${safeObservation} -->\n\n${proposal.suggestedChange}\n`;
    writeFileSync(targetPath, original + changeBlock);
    ctx.proposalsDb.markApplied(proposalId);
    await auditProposal("applied", proposalId, ctx.resolvedSqlitePath, {
      targetFile: proposal.targetFile,
      targetPath,
      backupPath,
      timestamp,
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
