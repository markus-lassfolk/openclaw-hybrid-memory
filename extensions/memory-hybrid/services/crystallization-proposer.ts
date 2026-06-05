import { getEnv } from "../utils/env-manager.js";
/**
 * Crystallization Proposer — orchestrate the full propose→approve→write pipeline (Issue #208).
 *
 * Combines pattern detection, skill crystallization, SkillValidator and CrystallizationStore
 * into a single entry point for the crystallization workflow.
 *
 * Human approval is always required (autoApprove=false by default).
 * When autoApprove=true the proposer immediately writes the skill to disk.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile, atomicWriteSkillDir } from "../utils/atomic-write.js";
import { bumpSkillsSnapshotBestEffort } from "./bump-skills-snapshot.js";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { WorkflowPattern, WorkflowStore } from "../backends/workflow-store.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { escapeRegExp, stripLeadingHtmlComments } from "../utils/text.js";
import { capturePluginError } from "./error-reporter.js";
import {
  GeneratedSkillValidationService,
  type SkillProposalValidationResult,
  detailSkillProposalValidation,
  summarizeSkillProposalValidation,
} from "./generated-skill-validation.js";
import { detectCrystallizationCandidates } from "./pattern-detector.js";
import {
  buildCrystallizationInstallFiles,
  CRYSTALLIZATION_EXEC_SCRIPT_REL_PATH,
  crystallizeSkill,
} from "./skill-crystallizer.js";
import {
  formatYamlFrontmatterScalar,
  sanitizeApprovedSkillSlug,
} from "./skill-crystallizer-helpers.js";
import {
  findQuarantinedSkillDir,
  quarantineCrystallizedSkillOnDisk,
  removeCrystallizedSkillDir,
  restoreCrystallizedSkillOnDisk,
} from "./crystallization-disk.js";
import { buildNonPlaceholderEmailPattern } from "./skill-validator.js";

/** Cap new proposals per runCycle to avoid flooding the queue when many patterns qualify. */
const MAX_PROPOSALS_PER_CYCLE = 20;

/** When renaming, replace the first Markdown ATX H1 in the body (after frontmatter), if any. */
function replaceFirstBodyH1AfterFrontmatter(skillContent: string, newTitle: string): string {
  const stripped = stripLeadingHtmlComments(skillContent);
  const head = skillContent.slice(0, skillContent.length - stripped.length);
  let body = stripped;
  let prefix = head;
  const fmMatch = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (fmMatch) {
    const frontmatter = fmMatch[0];
    prefix += frontmatter;
    body = body.slice(frontmatter.length);
  }
  const leadingNewlineMatch = body.match(/^\r?\n/);
  const leadingNewline = leadingNewlineMatch ? leadingNewlineMatch[0] : "";
  body = body.replace(/^\r?\n/, "");
  const h1Line = /^(#[ \t]+(?!#)\S[^\r\n]*)(\r?)$/m;
  if (!h1Line.test(body)) {
    return skillContent;
  }
  return prefix + leadingNewline + body.replace(h1Line, (_match, _oldLine: string, cr: string) => `# ${newTitle}${cr}`);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface ProposeResult {
  proposed: number;
  skipped: number;
  reasons: string[];
}

interface ApproveResult {
  success: boolean;
  outputPath?: string;
  message: string;
}

export interface RescanInstalledSkillsResult {
  scanned: number;
  quarantined: number;
  skipped: number;
  /** Skill directories moved out of the active output tree on quarantine. */
  diskQuarantined: number;
  errors: string[];
  messages: string[];
}

const RESCAN_MESSAGE_LIMIT = 100;

function pushLimitedMessage(messages: string[], message: string): boolean {
  if (messages.length < RESCAN_MESSAGE_LIMIT) {
    messages.push(message);
    return true;
  }
  return false;
}

/**
 * Derive the root output directory from an installed skill's absolute path.
 * Falls back to `fallbackOutputDir` when the path does not match the expected
 * `/<skillName>/SKILL.md` suffix.  Returns `"/"` (never `""`) when the skill
 * is installed directly under filesystem root (e.g. `/my-skill/SKILL.md`).
 *
 * @internal exported for unit testing only
 */
export function outputDirForInstalledSkill(outputPath: string, skillName: string, fallbackOutputDir: string): string {
  const normalizedOutputPath = resolve(outputPath);
  const expectedSuffix = resolve(`/${skillName}/SKILL.md`);
  if (!normalizedOutputPath.endsWith(expectedSuffix)) {
    return fallbackOutputDir;
  }
  return normalizedOutputPath.slice(0, -expectedSuffix.length) || "/";
}

// ---------------------------------------------------------------------------
// CrystallizationProposer
// ---------------------------------------------------------------------------

export class CrystallizationProposer {
  private readonly validator: GeneratedSkillValidationService;

  constructor(
    private readonly workflowStore: WorkflowStore | null,
    private readonly crystallizationStore: CrystallizationStore,
    private readonly cfg: CrystallizationConfig,
  ) {
    this.validator = new GeneratedSkillValidationService(
      cfg.placeholderEmailDomains?.length
        ? { emailPattern: buildNonPlaceholderEmailPattern(cfg.placeholderEmailDomains) }
        : undefined,
      cfg.sectionTaxonomy,
    );
  }

  // -------------------------------------------------------------------------
  // runCycle — detect candidates and create proposals
  // -------------------------------------------------------------------------

  /**
   * Run one crystallization cycle:
   * 1. Detect candidates from workflow patterns
   * 2. Validate each candidate
   * 3. Store as pending proposals (or auto-approve if configured)
   *
   * Returns a summary of what was proposed / skipped.
   */
  runCycle(opts?: { autoApproveOverride?: boolean }): ProposeResult {
    if (!this.cfg.enabled) {
      return {
        proposed: 0,
        skipped: 0,
        reasons: ["Crystallization is disabled"],
      };
    }
    if (!this.workflowStore) {
      return {
        proposed: 0,
        skipped: 0,
        reasons: ["Crystallization workflow store is not available"],
      };
    }

    // Cap at maxCrystallized
    const approvedCount = this.crystallizationStore.count("approved");
    if (approvedCount >= this.cfg.maxCrystallized) {
      return {
        proposed: 0,
        skipped: 0,
        reasons: [`maxCrystallized limit reached (${this.cfg.maxCrystallized})`],
      };
    }

    let proposed = 0;
    let skipped = 0;
    const reasons: string[] = [];

    const pendingCount = this.crystallizationStore.count("pending");
    if (this.cfg.maxPendingProposals > 0 && pendingCount >= this.cfg.maxPendingProposals) {
      return {
        proposed: 0,
        skipped: 0,
        reasons: [`maxPendingProposals limit reached (${pendingCount}/${this.cfg.maxPendingProposals})`],
      };
    }

    if (this.cfg.pruneUnusedDays > 0) {
      const pruned = this.crystallizationStore.pruneStalePendingProposals(this.cfg.pruneUnusedDays);
      if (pruned > 0) {
        reasons.push(`Pruned ${pruned} stale pending proposal(s) older than ${this.cfg.pruneUnusedDays} days`);
      }
    }

    const candidates = detectCrystallizationCandidates(this.workflowStore, this.crystallizationStore, this.cfg);
    if (candidates.length === 0) {
      return { proposed: 0, skipped: 0, reasons: reasons.length > 0 ? reasons : ["No new candidates found"] };
    }
    const autoApprove = opts?.autoApproveOverride ?? this.cfg.autoApprove;
    const remainingSlots = Math.max(0, this.cfg.maxCrystallized - approvedCount);
    const pendingRemaining =
      this.cfg.maxPendingProposals > 0 ? Math.max(0, this.cfg.maxPendingProposals - pendingCount) : Number.POSITIVE_INFINITY;
    const cycleCap = autoApprove
      ? Math.min(remainingSlots, pendingRemaining)
      : Math.min(MAX_PROPOSALS_PER_CYCLE, Math.max(remainingSlots, 1), pendingRemaining);
    const batch = candidates.slice(0, cycleCap);
    if (batch.length < candidates.length) {
      reasons.push(
        `Processing ${batch.length} of ${candidates.length} candidate(s) this cycle (cap=${cycleCap})`,
      );
    }

    for (const candidate of batch) {
      try {
        const result = crystallizeSkill(
          {
            patternId: candidate.patternId,
            evidenceHash: candidate.evidenceHash,
            pattern: candidate.pattern,
          },
          this.cfg,
        );

        const outputDir = this.cfg.outputDir.replace(/^~/, getEnv("HOME") || homedir());
        const legacy = isLegacyMarkdownCrystallizationProposal(result.skillContent);
        const gsv = this.validator.validate(
          {
            outputDir,
            proposedOutputPath: result.proposedOutputPath,
            skillName: result.skillName,
            skillContent: result.skillContent,
            pattern: candidate.pattern,
          },
          { legacyQueuedCrystallization: legacy },
        );
        const patternSnapshot = JSON.stringify(candidate.pattern);

        if (gsv.approvalDecision === "deny") {
          // Record as rejected so we have durable provenance + reason, and suppress immediate regen.
          this.crystallizationStore.create({
            patternId: candidate.patternId,
            evidenceHash: candidate.evidenceHash,
            skillName: result.skillName,
            skillContent: result.skillContent,
            patternSnapshot,
            proposalCardJson: JSON.stringify(result.proposalCard),
            category: result.proposalCard.category,
            description: result.proposalCard.description,
            confidence: result.proposalCard.confidence,
            recommendedOutput: result.proposalCard.recommended_output,
            status: "rejected",
            rejectionReason: `generated-skill-validation: ${detailSkillProposalValidation(gsv)}`,
            validationResult: gsv,
          });
          skipped++;
          reasons.push(`Rejected '${result.skillName}': failed validation — ${summarizeSkillProposalValidation(gsv)}`);
          continue;
        }

        const proposalInput = {
          patternId: candidate.patternId,
          evidenceHash: candidate.evidenceHash,
          skillName: result.skillName,
          skillContent: result.skillContent,
          patternSnapshot,
          proposalCardJson: JSON.stringify(result.proposalCard),
          category: result.proposalCard.category,
          description: result.proposalCard.description,
          confidence: result.proposalCard.confidence,
          recommendedOutput: result.proposalCard.recommended_output,
          status: "validated" as const,
          validationResult: gsv,
        };

        if (autoApprove && gsv.approvalDecision === "allow") {
          const approval = this.crystallizationStore.createApprovedWithinCap(proposalInput, this.cfg.maxCrystallized);
          if (approval.kind === "limit-reached") {
            skipped++;
            reasons.push(`Skipped '${result.skillName}': maxCrystallized limit reached (${this.cfg.maxCrystallized})`);
            continue;
          }

          const outputPath = this.computeOutputPath(approval.proposal.skillName);
          try {
            this.writeSkillPackage(
              approval.proposal.skillName,
              outputPath,
              this.injectInstallMetadata(approval.proposal, outputPath),
              parsePatternSnapshot(approval.proposal.patternSnapshot),
              approval.proposal.patternId,
            );
          } catch (writeErr) {
            this.crystallizationStore.revertApproval(approval.proposal.id);
            skipped++;
            const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
            reasons.push(`Skipped '${result.skillName}': auto-approve write failed (reverted) — ${msg}`);
            continue;
          }
          try {
            this.crystallizationStore.install(approval.proposal.id, outputPath);
          } catch (installErr) {
            removeCrystallizedSkillDir(outputPath);
            this.crystallizationStore.revertApproval(approval.proposal.id);
            skipped++;
            const msg = installErr instanceof Error ? installErr.message : String(installErr);
            reasons.push(`Skipped '${result.skillName}': auto-approve install failed (reverted) — ${msg}`);
            continue;
          }
          proposed++;
          continue;
        }

        // Store as validated proposal (awaiting human approval)
        this.crystallizationStore.create(proposalInput);

        if (autoApprove && gsv.approvalDecision !== "allow") {
          reasons.push(
            `Queued '${result.skillName}' (auto-approve skipped; needs override or fixes): ${summarizeSkillProposalValidation(gsv)}`,
          );
        }

        proposed++;
      } catch (err) {
        skipped++;
        const msg = err instanceof Error ? err.message : String(err);
        reasons.push(`Error processing candidate ${candidate.patternId}: ${msg}`);
        capturePluginError(err instanceof Error ? err : new Error(msg), {
          operation: "run-cycle",
          subsystem: "crystallization-proposer",
        });
      }
    }

    return { proposed, skipped, reasons };
  }

  // -------------------------------------------------------------------------
  // validateProposal — dry-run the full GSV pipeline without writing to disk
  // -------------------------------------------------------------------------

  /**
   * Run the exact same validation pipeline used by `approveProposal` (static checks +
   * dry-load filesystem verification + synthetic activation eval) WITHOUT writing
   * anything to disk.  This makes `skills validate <id>` produce the same outcome
   * prediction as `skills install <id>` would (issue #1402).
   *
   * A `null` WorkflowStore is fine here — this method only uses the validator and the
   * crystallization store; the workflow-store-backed pattern detector is not involved.
   *
   * @param proposalId - The crystallization proposal to validate.
   * @param opts.name - Rename the skill before validation (mirrors the install --name flag).
   * @param opts.category - Override the category before validation.
   * @param opts.recommendedOutput - Override the recommended-output field.
   * @returns Full validation result, or `null` when the proposal ID is not found.
   *          A "deny" approval decision means install would have failed; "allow-with-override"
   *          means install would require --override-warnings; "allow" means install succeeds.
   */
  validateProposal(
    proposalId: string,
    opts?: {
      name?: string;
      category?: string;
      description?: string;
      recommendedOutput?: "SKILL.md only";
    },
  ): SkillProposalValidationResult | null {
    const proposal = this.crystallizationStore.getById(proposalId);
    if (!proposal) return null;

    if (proposal.status !== "validated" && proposal.status !== "drafted") {
      return failedProposalValidation(`Proposal '${proposalId}' is not approvable (status: ${proposal.status})`);
    }

    const approvedCount = this.crystallizationStore.count("approved");
    if (approvedCount >= this.cfg.maxCrystallized) {
      return failedProposalValidation(`maxCrystallized limit reached (${this.cfg.maxCrystallized})`);
    }

    const desiredName = opts?.name?.trim() ? opts.name.trim() : proposal.skillName;
    const safeName = sanitizeApprovedSkillSlug(desiredName);
    const desiredCategory = opts?.category?.trim() ? opts.category.trim() : proposal.category;
    const desiredRecommendedOutput = opts?.recommendedOutput ?? proposal.recommendedOutput;

    const { skillContent: rewrittenContent } = this.applyOverridesToDraft(proposal, {
      skillName: safeName,
      category: desiredCategory,
      description: opts?.description?.trim() || undefined,
      recommendedOutput: desiredRecommendedOutput,
    });

    const outputDir = this.cfg.outputDir.replace(/^~/, getEnv("HOME") || homedir());
    const proposedOutputPath = this.computeOutputPath(safeName);
    const pattern = parsePatternSnapshot(proposal.patternSnapshot);
    const legacy = isLegacyMarkdownCrystallizationProposal(rewrittenContent);

    return this.validator.validate(
      {
        outputDir,
        proposedOutputPath,
        skillName: safeName,
        skillContent: rewrittenContent,
        pattern,
      },
      { legacyQueuedCrystallization: legacy },
    );
  }

  // -------------------------------------------------------------------------
  // approveProposal — write skill to disk and mark as approved
  // -------------------------------------------------------------------------

  approveProposal(
    proposalId: string,
    opts?: {
      overrideWarnings?: boolean;
      name?: string;
      category?: string;
      description?: string;
      recommendedOutput?: "SKILL.md only";
    },
  ): ApproveResult {
    const proposal = this.crystallizationStore.getById(proposalId);
    if (!proposal) {
      return { success: false, message: `Proposal '${proposalId}' not found` };
    }
    if (proposal.status !== "validated" && proposal.status !== "drafted") {
      return {
        success: false,
        message: `Proposal '${proposalId}' is not approvable (status: ${proposal.status})`,
      };
    }

    const desiredName = opts?.name?.trim() ? opts.name.trim() : proposal.skillName;
    const safeName = sanitizeApprovedSkillSlug(desiredName);
    const desiredCategory = opts?.category?.trim() ? opts.category.trim() : proposal.category;
    const desiredRecommendedOutput = opts?.recommendedOutput ?? proposal.recommendedOutput;

    const { skillContent: rewrittenContent, proposalCardJson: rewrittenCardJson } = this.applyOverridesToDraft(
      proposal,
      {
        skillName: safeName,
        category: desiredCategory,
        description: opts?.description?.trim() || undefined,
        recommendedOutput: desiredRecommendedOutput,
      },
    );

    const outputDir = this.cfg.outputDir.replace(/^~/, getEnv("HOME") || homedir());
    const proposedOutputPath = this.computeOutputPath(safeName);
    const pattern = parsePatternSnapshot(proposal.patternSnapshot);
    const legacy = isLegacyMarkdownCrystallizationProposal(rewrittenContent);
    const validation = this.validator.validate(
      {
        outputDir,
        proposedOutputPath,
        skillName: safeName,
        skillContent: rewrittenContent,
        pattern,
      },
      { legacyQueuedCrystallization: legacy },
    );
    this.crystallizationStore.saveValidationResult(proposalId, validation);
    if (validation.approvalDecision === "deny") {
      return {
        success: false,
        message: `Validation failed: ${detailSkillProposalValidation(validation)}`,
      };
    }
    if (validation.approvalDecision === "allow-with-override" && opts?.overrideWarnings !== true) {
      return {
        success: false,
        message: `Validation requires explicit override: ${summarizeSkillProposalValidation(validation)}`,
      };
    }

    // Approve in DB first (source of truth), then write to disk, then mark installed.
    const approval = this.crystallizationStore.approveWithinCap(proposalId, this.cfg.maxCrystallized, {
      skillName: safeName,
      skillContent: rewrittenContent,
      category: desiredCategory,
      ...(opts?.description?.trim() ? { description: opts.description.trim() } : {}),
      recommendedOutput: desiredRecommendedOutput,
      proposalCardJson: rewrittenCardJson,
    });
    if (approval.kind === "limit-reached") {
      return {
        success: false,
        message: `maxCrystallized limit reached (${this.cfg.maxCrystallized})`,
      };
    }
    if (approval.kind !== "approved") {
      return { success: false, message: "Failed to update proposal status" };
    }
    const updated = approval.proposal;

    const outputPath = this.computeOutputPath(updated.skillName);

    try {
      this.writeSkillPackage(
        updated.skillName,
        outputPath,
        this.injectInstallMetadata(updated, outputPath),
        pattern,
        updated.patternId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.crystallizationStore.revertApproval(updated.id);
      return {
        success: false,
        message: `Failed to write skill (approval reverted): ${msg}`,
      };
    }

    try {
      this.crystallizationStore.install(updated.id, outputPath);
      this.trySupersedeOlderInstalls(updated.patternId, updated.id);
      void bumpSkillsSnapshotBestEffort({ changedPath: outputPath, reason: "hybrid-memory-crystallization-approve" });
    } catch (err) {
      removeCrystallizedSkillDir(outputPath);
      this.crystallizationStore.revertApproval(updated.id);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to mark skill installed (approval reverted): ${msg}`,
      };
    }

    return {
      success: true,
      outputPath,
      message: `Skill '${updated.skillName}' written to ${outputPath}`,
    };
  }

  // -------------------------------------------------------------------------
  // rejectProposal
  // -------------------------------------------------------------------------

  rejectProposal(proposalId: string, reason?: string): ApproveResult {
    const proposal = this.crystallizationStore.getById(proposalId);
    if (!proposal) {
      return { success: false, message: `Proposal '${proposalId}' not found` };
    }
    if (proposal.status !== "validated" && proposal.status !== "drafted" && proposal.status !== "approved") {
      return {
        success: false,
        message: `Proposal '${proposalId}' is not rejectable (status: ${proposal.status})`,
      };
    }

    const rejectionReason = reason ?? validationRejectionReason(proposal.validationResult);
    const updated = this.crystallizationStore.reject(proposalId, rejectionReason);
    if (!updated) {
      return { success: false, message: "Failed to update proposal status" };
    }

    return { success: true, message: `Proposal '${proposalId}' rejected` };
  }

  /**
   * Restore a quarantined proposal: re-validate, move skill back to the active output tree, mark installed.
   */
  restoreProposal(
    proposalId: string,
    opts?: { overrideWarnings?: boolean },
  ): ApproveResult {
    const proposal = this.crystallizationStore.getById(proposalId);
    if (!proposal) {
      return { success: false, message: `Proposal '${proposalId}' not found` };
    }
    if (proposal.status !== "quarantined") {
      return {
        success: false,
        message: `Proposal '${proposalId}' is not restorable (status: ${proposal.status})`,
      };
    }

    const activeOutputDir = this.cfg.outputDir.replace(/^~/, getEnv("HOME") || homedir());
    const located = locateProposalSkillOnDisk(proposal, activeOutputDir);
    if (!located) {
      return {
        success: false,
        message: `Quarantined skill files not found for '${proposal.skillName}'`,
      };
    }

    let skillContent: string;
    try {
      skillContent = readFileSync(located.skillPath, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to read quarantined skill: ${msg}` };
    }

    const pattern = parsePatternSnapshot(proposal.patternSnapshot);
    const targetOutputPath = this.computeOutputPath(proposal.skillName);
    const legacy = isLegacyMarkdownCrystallizationProposal(skillContent);
    const validation = this.validator.validate(
      {
        outputDir: activeOutputDir,
        proposedOutputPath: targetOutputPath,
        skillName: proposal.skillName,
        skillContent,
        pattern,
      },
      { legacyQueuedCrystallization: legacy },
    );
    this.crystallizationStore.saveValidationResult(proposalId, validation);
    if (validation.approvalDecision === "deny") {
      return {
        success: false,
        message: `Validation failed: ${detailSkillProposalValidation(validation)}`,
      };
    }
    if (validation.approvalDecision === "allow-with-override" && opts?.overrideWarnings !== true) {
      return {
        success: false,
        message: `Validation requires explicit override: ${summarizeSkillProposalValidation(validation)}`,
      };
    }

    const restoreResult = restoreCrystallizedSkillOnDisk(located.skillDir, activeOutputDir, proposal.skillName);
    if (!restoreResult.outputPath) {
      return {
        success: false,
        message: restoreResult.error ?? "Failed to restore skill directory to active output tree",
      };
    }

    const restored = this.crystallizationStore.restoreFromQuarantine(proposalId, restoreResult.outputPath);
    if (!restored) {
      return { success: false, message: "Failed to update proposal status to installed" };
    }

    return {
      success: true,
      outputPath: restoreResult.outputPath,
      message: `Skill '${proposal.skillName}' restored to ${restoreResult.outputPath}`,
    };
  }

  /**
   * Re-validate on-disk SKILL.md for every installed proposal (operator / cron hygiene).
   * Persists validation via {@link CrystallizationStore.saveValidationResult}; on `deny`, sets status `quarantined`.
   */
  rescanInstalledSkills(): RescanInstalledSkillsResult {
    const installed = this.crystallizationStore.list({ status: "installed", limit: 500 });
    let scanned = 0;
    let quarantined = 0;
    let diskQuarantined = 0;
    let skipped = 0;
    const errors: string[] = [];
    const messages: string[] = [];
    let truncated = false;
    const fallbackOutputDir = this.cfg.outputDir.replace(/^~/, getEnv("HOME") || homedir());

    for (const proposal of installed) {
      if (!proposal.outputPath?.trim()) {
        skipped++;
        truncated =
          !pushLimitedMessage(messages, `Skipped ${proposal.id} (${proposal.skillName}): no outputPath`) || truncated;
        continue;
      }
      let skillContent: string;
      try {
        skillContent = readFileSync(proposal.outputPath, "utf-8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${proposal.id}: read failed — ${msg}`);
        continue;
      }

      scanned++;
      try {
        const pattern = parsePatternSnapshot(proposal.patternSnapshot);
        const legacy = isLegacyMarkdownCrystallizationProposal(skillContent);
        const outputDir = outputDirForInstalledSkill(proposal.outputPath, proposal.skillName, fallbackOutputDir);
        const validation = this.validator.validate(
          {
            outputDir,
            proposedOutputPath: proposal.outputPath,
            skillName: proposal.skillName,
            skillContent,
            pattern,
          },
          { legacyQueuedCrystallization: legacy },
        );
        this.crystallizationStore.saveValidationResult(proposal.id, validation);
        if (validation.approvalDecision === "deny") {
          const detail = detailSkillProposalValidation(validation);
          const reason = `stale validation: ${detail}`;
          const updated = this.crystallizationStore.quarantine(proposal.id, reason);
          if (updated) {
            quarantined++;
            const outputDir = outputDirForInstalledSkill(proposal.outputPath, proposal.skillName, fallbackOutputDir);
            const diskResult = quarantineCrystallizedSkillOnDisk(proposal.outputPath, outputDir);
            if (diskResult.movedTo) {
              diskQuarantined++;
              const quarantineSkillPath = join(diskResult.movedTo, "SKILL.md");
              this.crystallizationStore.updateOutputPath(proposal.id, quarantineSkillPath);
            } else if (diskResult.error) {
              errors.push(`${proposal.id}: disk quarantine failed — ${diskResult.error}`);
            }
            truncated =
              !pushLimitedMessage(
                messages,
                `Quarantined ${proposal.skillName}: ${summarizeSkillProposalValidation(validation)}${diskResult.movedTo ? ` (moved to ${diskResult.movedTo})` : ""}`,
              ) || truncated;
          } else {
            errors.push(`${proposal.id}: quarantine update failed`);
          }
        } else {
          truncated =
            !pushLimitedMessage(
              messages,
              `OK ${proposal.skillName}: ${summarizeSkillProposalValidation(validation)}`,
            ) || truncated;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${proposal.id}: validate failed — ${msg}`);
      }
    }

    if (truncated) {
      messages.push(`Message output truncated after ${RESCAN_MESSAGE_LIMIT} entries`);
    }

    return { scanned, quarantined, skipped, diskQuarantined, errors, messages };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private computeOutputPath(skillName: string): string {
    const outputDir = this.cfg.outputDir.replace(/^~/, getEnv("HOME") || homedir());
    return resolve(outputDir, skillName, "SKILL.md");
  }

  private applyOverridesToDraft(
    proposal: {
      skillName: string;
      skillContent: string;
      proposalCardJson?: string;
    },
    overrides: {
      skillName: string;
      category?: string;
      description?: string;
      recommendedOutput?: "SKILL.md only";
    },
  ): { skillContent: string; proposalCardJson?: string } {
    let skillContent = proposal.skillContent;
    if (overrides.skillName && overrides.skillName !== proposal.skillName) {
      skillContent = replaceFirstBodyH1AfterFrontmatter(skillContent, overrides.skillName);
      skillContent = patchOpeningYamlField(skillContent, "name", overrides.skillName);
    }
    if (overrides.category) {
      skillContent = skillContent.replace(/^\*\*Category:\*\* .+$/m, () => `**Category:** ${overrides.category}`);
      skillContent = patchOpeningYamlField(skillContent, "category", overrides.category);
    }
    if (overrides.description) {
      skillContent = skillContent.replace(
        /^\*\*Description:\*\* .+$/m,
        () => `**Description:** ${overrides.description}`,
      );
      skillContent = patchOpeningYamlField(skillContent, "description", overrides.description);
    }
    if (overrides.recommendedOutput) {
      skillContent = skillContent.replace(
        /^\*\*Recommended output:\*\* .+$/m,
        () => `**Recommended output:** ${overrides.recommendedOutput}`,
      );
    }

    let proposalCardJson = proposal.proposalCardJson;
    if (proposalCardJson) {
      try {
        const parsed = JSON.parse(proposalCardJson) as Record<string, unknown>;
        parsed.name = overrides.skillName;
        if (overrides.category) parsed.category = overrides.category;
        if (overrides.description) parsed.description = overrides.description;
        if (overrides.recommendedOutput) parsed.recommended_output = overrides.recommendedOutput;
        proposalCardJson = JSON.stringify(parsed);
      } catch {
        // leave as-is
      }
    }

    return { skillContent, proposalCardJson };
  }

  private injectInstallMetadata(
    proposal: {
      id: string;
      patternId: string;
      evidenceHash: string;
      skillContent: string;
    },
    outputPath: string,
  ): string {
    const header = `<!-- openclaw:skill-proposal id=${proposal.id} pattern_id=${proposal.patternId} evidence_hash=${proposal.evidenceHash} output_path=${outputPath} -->`;
    if (proposal.skillContent.includes("<!-- openclaw:skill-proposal")) {
      return proposal.skillContent;
    }
    const frontmatterMatch = proposal.skillContent.match(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[0].trimEnd();
      const rest = proposal.skillContent.slice(frontmatterMatch[0].length).replace(/^\r?\n/, "");
      return `${frontmatter}

${header}

${rest}`;
    }
    return `${header}

${proposal.skillContent}`;
  }

  private trySupersedeOlderInstalls(patternId: string, supersededBy: string): void {
    try {
      const existing = this.crystallizationStore.listByPatternId(patternId);
      for (const p of existing) {
        if (p.id === supersededBy) continue;
        if (p.status === "installed" || p.status === "approved" || p.status === "quarantined") {
          this.crystallizationStore.supersede(p.id, supersededBy);
        }
      }
    } catch {
      // best-effort; ignore
    }
  }

  private writeSkillPackage(
    skillName: string,
    outputPath: string,
    skillContent: string,
    pattern: WorkflowPattern | undefined,
    patternId: string | undefined,
  ): void {
    const skillDir = dirname(outputPath);
    const files = buildCrystallizationInstallFiles(skillName, skillContent, pattern, patternId);
    const sidecarPaths = Object.keys(files).filter((p) => p !== "SKILL.md");
    if (sidecarPaths.length === 0) {
      atomicWriteFile(outputPath, skillContent);
      return;
    }
    atomicWriteSkillDir(skillDir, files, {
      executableRelativePaths: sidecarPaths.includes(CRYSTALLIZATION_EXEC_SCRIPT_REL_PATH)
        ? [CRYSTALLIZATION_EXEC_SCRIPT_REL_PATH]
        : undefined,
    });
  }
}

/** Max lines scanned inside frontmatter when locating a multiline YAML value (bounded behavior). */
const MAX_YAML_VALUE_SCAN_LINES = 512;

/** Update a key in the opening YAML frontmatter block (after optional leading HTML comment). */
export function patchOpeningYamlField(skillContent: string, key: string, value: string): string {
  const body = stripLeadingHtmlComments(skillContent);
  const prefix = skillContent.slice(0, skillContent.length - body.length);
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return skillContent;
  const inner = m[1]!;
  const openingLineBreak = m[0].startsWith("---\r\n") ? "\r\n" : "\n";
  const innerLineBreak = inner.includes("\r\n") ? "\r\n" : openingLineBreak;
  const lines = inner.split(/\r?\n/);
  const keyLineRe = new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`);
  let keyIdx = -1;
  const scanCap = Math.min(lines.length, MAX_YAML_VALUE_SCAN_LINES);
  for (let i = 0; i < scanCap; i++) {
    if (keyLineRe.test(lines[i]!)) {
      keyIdx = i;
      break;
    }
  }
  const yamlScalar = formatYamlFrontmatterScalar(value);
  let nextLines: string[];
  if (keyIdx < 0) {
    nextLines = [`${key}: ${yamlScalar}`, ...lines];
  } else {
    const endExclusive = endIndexForYamlValueBlock(lines, keyIdx, keyLineRe);
    nextLines = [...lines.slice(0, keyIdx), `${key}: ${yamlScalar}`, ...lines.slice(endExclusive)];
  }
  const nextInner = nextLines.join(innerLineBreak);
  const newBlock = `---${innerLineBreak}${nextInner}${innerLineBreak}---${innerLineBreak}`;
  return prefix + body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, newBlock);
}

function stripInlineYamlTrailingComment(fragment: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return fragment.slice(0, i).trimEnd();
  }
  return fragment.trimEnd();
}

function isTopLevelYamlKeyLine(line: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*:(?:\s|$)/.test(line);
}

function leadingIndentLen(line: string): number {
  const m = /^([ \t]*)/.exec(line);
  return m ? m[1]?.length : 0;
}

function endIndexForYamlValueBlock(lines: string[], startIdx: number, keyLineRe: RegExp): number {
  const line = lines[startIdx]!;
  const km = keyLineRe.exec(line);
  if (!km) return startIdx + 1;
  const afterColon = km[1] ?? "";
  const trimmed = stripInlineYamlTrailingComment(afterColon).trim();
  const blockHdr = trimmed.match(/^([|>])(.*)$/);
  if (blockHdr) {
    const afterMarker = (blockHdr[2] ?? "").trim();
    if (/^(?:[-+]?([1-9][0-9]*)?|([1-9][0-9]*)?[-+]?)$/.test(afterMarker)) {
      let j = startIdx + 1;
      while (j < lines.length && j - startIdx < MAX_YAML_VALUE_SCAN_LINES) {
        if (isTopLevelYamlKeyLine(lines[j]!)) break;
        j++;
      }
      return j;
    }
  }
  const keyIndent = leadingIndentLen(line);
  let j = startIdx + 1;
  while (j < lines.length && j - startIdx < MAX_YAML_VALUE_SCAN_LINES) {
    const L = lines[j]!;
    if (isTopLevelYamlKeyLine(L)) break;
    if (L.trim() === "") {
      let k = j + 1;
      while (k < lines.length && lines[k]?.trim() === "") k++;
      if (k >= lines.length) return j;
      if (isTopLevelYamlKeyLine(lines[k]!)) break;
      if (leadingIndentLen(lines[k]!) > keyIndent) {
        j++;
        continue;
      }
      break;
    }
    if (leadingIndentLen(L) > keyIndent) {
      j++;
      continue;
    }
    break;
  }
  return j;
}

function parsePatternSnapshot(snapshot: string): WorkflowPattern | undefined {
  if (!snapshot?.trim()) return undefined;
  try {
    const raw = JSON.parse(snapshot) as unknown;
    if (!raw || typeof raw !== "object") return undefined;
    const o = raw as Record<string, unknown>;
    if (!Array.isArray(o.toolSequence) || !o.toolSequence.every((t) => typeof t === "string")) return undefined;
    if (
      typeof o.totalCount !== "number" ||
      typeof o.successCount !== "number" ||
      typeof o.failureCount !== "number" ||
      typeof o.successRate !== "number" ||
      typeof o.avgDurationMs !== "number"
    ) {
      return undefined;
    }
    if (!Array.isArray(o.exampleGoals) || !o.exampleGoals.every((g) => typeof g === "string")) return undefined;
    return o as unknown as WorkflowPattern;
  } catch {
    return undefined;
  }
}

/** Queued proposals from older crystallizers start Markdown without YAML frontmatter. */

function locateProposalSkillOnDisk(
  proposal: { skillName: string; outputPath?: string },
  activeOutputDir: string,
): { skillDir: string; skillPath: string } | null {
  const storedPath = proposal.outputPath?.trim();
  if (storedPath && existsSync(storedPath)) {
    return { skillDir: dirname(storedPath), skillPath: storedPath };
  }
  if (storedPath) {
    const storedDir = dirname(storedPath);
    const storedSkillPath = join(storedDir, "SKILL.md");
    if (existsSync(storedSkillPath)) {
      return { skillDir: storedDir, skillPath: storedSkillPath };
    }
  }
  const quarantined = findQuarantinedSkillDir(proposal.skillName, activeOutputDir);
  if (quarantined) {
    return { skillDir: quarantined, skillPath: join(quarantined, "SKILL.md") };
  }
  return null;
}

function failedProposalValidation(message: string): SkillProposalValidationResult {
  return {
    schemaVersion: 1,
    validatedAt: new Date().toISOString(),
    overallStatus: "failed",
    approvalDecision: "deny",
    staticValidation: {
      status: "failed",
      violations: [message],
      frontmatter: {},
      safeOutputPath: "",
    },
    dryLoadValidation: {
      status: "failed",
      violations: ["Skipped — pre-flight check failed"],
      discovered: {},
    },
    syntheticActivationEval: {
      status: "failed",
      score: 0,
      cases: {
        positive: "",
        negative: "",
        edge: "",
      },
      results: {
        positiveMatched: false,
        negativeMatched: false,
        edgeMatched: false,
      },
      notes: ["Skipped — pre-flight check failed"],
    },
    canarySession: { status: "not-run" },
  };
}

function isLegacyMarkdownCrystallizationProposal(skillContent: string): boolean {
  const body = stripLeadingHtmlComments(skillContent);
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]?.trim() === "") i++;
  return lines[i]?.trim() !== "---";
}

function validationRejectionReason(
  validationResult: ReturnType<typeof GeneratedSkillValidationService.prototype.validate> | undefined,
): string | undefined {
  if (!validationResult) return undefined;
  return `generated-skill-validation: ${detailSkillProposalValidation(validationResult)}`;
}
