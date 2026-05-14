import { getEnv } from "../utils/env-manager.js";
/**
 * Crystallization Proposer — orchestrate the full propose→approve→write pipeline (Issue #208).
 *
 * Combines PatternDetector, SkillCrystallizer, SkillValidator and CrystallizationStore
 * into a single entry point for the crystallization workflow.
 *
 * Human approval is always required (autoApprove=false by default).
 * When autoApprove=true the proposer immediately writes the skill to disk.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { capturePluginError } from "./error-reporter.js";
import { GeneratedSkillValidationService, summarizeSkillProposalValidation } from "./generated-skill-validation.js";
import { PatternDetector } from "./pattern-detector.js";
import { SkillCrystallizer, normalizeSkillName } from "./skill-crystallizer.js";

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

// ---------------------------------------------------------------------------
// CrystallizationProposer
// ---------------------------------------------------------------------------

export class CrystallizationProposer {
  private readonly detector: PatternDetector;
  private readonly crystallizer: SkillCrystallizer;
  private readonly validator: GeneratedSkillValidationService;

  constructor(
    private readonly workflowStore: WorkflowStore,
    private readonly crystallizationStore: CrystallizationStore,
    private readonly cfg: CrystallizationConfig,
  ) {
    this.detector = new PatternDetector(workflowStore, crystallizationStore, cfg);
    this.crystallizer = new SkillCrystallizer(cfg);
    this.validator = new GeneratedSkillValidationService();
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
  runCycle(): ProposeResult {
    if (!this.cfg.enabled) {
      return { proposed: 0, skipped: 0, reasons: ["Crystallization is disabled"] };
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

    const candidates = this.detector.detect();
    if (candidates.length === 0) {
      return { proposed: 0, skipped: 0, reasons: ["No new candidates found"] };
    }

    let proposed = 0;
    let skipped = 0;
    const reasons: string[] = [];

    for (const candidate of candidates) {
      try {
        const result = this.crystallizer.crystallize(candidate);
        const validation = this.validator.validate({
          outputDir: this.cfg.outputDir.replace(/^~/, getEnv("HOME") || homedir()),
          proposedOutputPath: result.proposedOutputPath,
          skillName: result.skillName,
          skillContent: result.skillContent,
          pattern: candidate.pattern,
        });

        const patternSnapshot = JSON.stringify(candidate.pattern);

        if (this.cfg.autoApprove) {
          // Re-check cap before approving each skill
          const currentApprovedCount = this.crystallizationStore.count("approved");
          if (currentApprovedCount >= this.cfg.maxCrystallized) {
            skipped++;
            reasons.push(`Skipped '${result.skillName}': maxCrystallized limit reached (${this.cfg.maxCrystallized})`);
            continue;
          }

          // Create proposal, approve in DB, THEN write to disk (DB is source of truth)
          const proposal = this.crystallizationStore.create({
            patternId: candidate.patternId,
            skillName: result.skillName,
            skillContent: result.skillContent,
            patternSnapshot,
            validationResult: validation,
          });
          if (validation.approvalDecision === "allow") {
            this.crystallizationStore.approve(proposal.id, result.proposedOutputPath);
            this.writeSkillToDisk(result.proposedOutputPath, result.skillContent);
          } else {
            skipped++;
            reasons.push(`Pending '${result.skillName}': ${summarizeSkillProposalValidation(validation)}`);
          }
          proposed++;
        } else {
          // Store as pending, awaiting human approval
          this.crystallizationStore.create({
            patternId: candidate.patternId,
            skillName: result.skillName,
            skillContent: result.skillContent,
            patternSnapshot,
            validationResult: validation,
          });
          proposed++;
          if (validation.overallStatus !== "passed") {
            reasons.push(`Pending '${result.skillName}': ${summarizeSkillProposalValidation(validation)}`);
          }
        }
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
  // approveProposal — write skill to disk and mark as approved
  // -------------------------------------------------------------------------

  approveProposal(proposalId: string, opts?: { overrideWarnings?: boolean }): ApproveResult {
    const proposal = this.crystallizationStore.getById(proposalId);
    if (!proposal) {
      return { success: false, message: `Proposal '${proposalId}' not found` };
    }
    if (proposal.status !== "pending") {
      return {
        success: false,
        message: `Proposal '${proposalId}' is not pending (status: ${proposal.status})`,
      };
    }

    // Check maxCrystallized limit before approving
    const approvedCount = this.crystallizationStore.count("approved");
    if (approvedCount >= this.cfg.maxCrystallized) {
      return {
        success: false,
        message: `maxCrystallized limit reached (${this.cfg.maxCrystallized})`,
      };
    }

    const outputDir = this.cfg.outputDir.replace(/^~/, getEnv("HOME") || homedir());
    const safeName = normalizeSkillName(proposal.skillName);
    const outputPath = `${outputDir}/${safeName}/SKILL.md`;

    // Re-validate before writing
    const validation = this.validator.validate({
      outputDir,
      proposedOutputPath: outputPath,
      skillName: safeName,
      skillContent: proposal.skillContent,
    });
    this.crystallizationStore.saveValidationResult(proposalId, validation);
    if (validation.approvalDecision === "deny") {
      return {
        success: false,
        message: `Validation failed: ${summarizeSkillProposalValidation(validation)}`,
      };
    }
    if (validation.approvalDecision === "allow-with-override" && opts?.overrideWarnings !== true) {
      return {
        success: false,
        message: `Validation requires explicit override: ${summarizeSkillProposalValidation(validation)}`,
      };
    }

    // Approve in DB first (source of truth), then write to disk
    const updated = this.crystallizationStore.approve(proposalId, outputPath);
    if (!updated) {
      return { success: false, message: "Failed to update proposal status" };
    }

    try {
      this.writeSkillToDisk(outputPath, proposal.skillContent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Approved but failed to write skill: ${msg}` };
    }

    return {
      success: true,
      outputPath,
      message: `Skill '${proposal.skillName}' written to ${outputPath}`,
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
    if (proposal.status !== "pending") {
      return {
        success: false,
        message: `Proposal '${proposalId}' is not pending (status: ${proposal.status})`,
      };
    }

    const updated = this.crystallizationStore.reject(proposalId, reason);
    if (!updated) {
      return { success: false, message: "Failed to update proposal status" };
    }

    return { success: true, message: `Proposal '${proposalId}' rejected` };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private writeSkillToDisk(outputPath: string, skillContent: string): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, skillContent, "utf-8");
  }
}
