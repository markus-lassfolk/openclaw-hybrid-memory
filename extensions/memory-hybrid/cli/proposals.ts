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

/**
 * Register CLI commands for persona proposal management
 * NOTE: These are human-only commands and NOT exposed as agent-callable tools
 */
export function registerProposalsCli(program: Chainable, ctx: ProposalsCliContext): void {
  const proposals = program.command("proposals").description("Manage persona proposals (human-only commands)");

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
        console.log(`\nUse 'openclaw proposals apply ${proposalId}' to apply the change.`);
      }
    });

  proposals
    .command("apply <proposalId>")
    .description("Apply an approved persona proposal to its target identity file")
    .action(async (proposalId: string) => {
      const proposal = ctx.proposalsDb.get(proposalId);
      if (!proposal) {
        console.error(`Proposal ${proposalId} not found`);
        process.exit(1);
      }

      if (proposal.status !== "approved") {
        console.error(`Proposal ${proposalId} is ${proposal.status}. Only approved proposals can be applied.`);
        process.exit(1);
      }

      // Re-validate targetFile against current allowedFiles config (defense against config changes or DB tampering)
      if (!ctx.cfg.personaProposals.allowedFiles.includes(proposal.targetFile as IdentityFileType)) {
        console.error(`Target file ${proposal.targetFile} is no longer in allowedFiles. Cannot apply.`);
        console.error(`Current allowedFiles: ${ctx.cfg.personaProposals.allowedFiles.join(", ")}`);
        process.exit(1);
      }

      // Additional path traversal defense (even though schema validates at creation)
      if (proposal.targetFile.includes("..") || proposal.targetFile.includes("/") || proposal.targetFile.includes("\\")) {
        console.error(`Invalid target file path: ${proposal.targetFile}. Path traversal detected.`);
        process.exit(1);
      }

      // Resolve target file path
      const targetPath = ctx.api.resolvePath(proposal.targetFile);

      if (!existsSync(targetPath)) {
        console.error(`Target file ${proposal.targetFile} not found at ${targetPath}`);
        process.exit(1);
      }

      // Create backup
      const backupPath = `${targetPath}.backup-${Date.now()}`;
      try {
        const original = readFileSync(targetPath, "utf-8");
        writeFileSync(backupPath, original);

        // Escape HTML comment sequences to prevent breakout
        const escapeHtmlComment = (text: string): string => {
          return text.replace(/-->/g, "-- >").replace(/<!--/g, "<! --");
        };

        // Validate content doesn't contain dangerous patterns
        const DANGEROUS_PATTERNS = /<script|<iframe|javascript:/i;
        if (DANGEROUS_PATTERNS.test(proposal.suggestedChange)) {
          console.error(`Proposal ${proposalId} contains potentially dangerous content (script tags, iframes, or javascript: URLs) and cannot be applied.`);
          process.exit(1);
        }

        // Apply change (simple append strategy)
        // TODO: Future enhancement - use LLM for smart diff application, content validation, merge conflict resolution
        const timestamp = new Date().toISOString();
        const safeObservation = escapeHtmlComment(proposal.observation);
        const changeBlock = `\n\n<!-- Proposal ${proposalId} applied at ${timestamp} -->\n<!-- Observation: ${safeObservation} -->\n\n${proposal.suggestedChange}\n`;
        writeFileSync(targetPath, original + changeBlock);

        // Mark as applied only after successful file write
        ctx.proposalsDb.markApplied(proposalId);

        await auditProposal("applied", proposalId, ctx.resolvedSqlitePath, {
          targetFile: proposal.targetFile,
          targetPath,
          backupPath,
          timestamp,
        }, { error: console.error });

        console.log(`Proposal ${proposalId} applied to ${proposal.targetFile}`);
        console.log(`Backup saved: ${backupPath}`);
        console.log(`\nChange:\n${proposal.suggestedChange}`);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: 'apply-proposal',
          subsystem: 'proposals',
          proposalId,
        });
        console.error(`Failed to apply proposal: ${err}`);
        process.exit(1);
      }
    });
}
