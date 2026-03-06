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
import { dirname } from "node:path";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { PatternDetector } from "./pattern-detector.js";
import { SkillCrystallizer } from "./skill-crystallizer.js";
import { SkillValidator } from "./skill-validator.js";
import { capturePluginError } from "./error-reporter.js";
import type { WorkflowStore } from "../backends/workflow-store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProposeResult {
  proposed: number;
  skipped: number;
  reasons: string[];
}

export interface ApproveResult {
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
  private readonly validator: SkillValidator;

  constructor(
    private readonly workflowStore: WorkflowStore,
    private readonly crystallizationStore: CrystallizationStore,
    private readonly cfg: CrystallizationConfig,
  ) {
    this.detector = new PatternDetector(workflowStore, crystallizationStore, cfg);
    this.crystallizer = new SkillCrystallizer(cfg);
    this.validator = new SkillValidator();
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

        // Static analysis gate
        const validation = this.validator.validate(result.skillContent);
        if (!validation.valid) {
          skipped++;
          reasons.push(
            `Skipped '${result.skillName}': failed validation — ${validation.violations.slice(0, 2).join("; ")}`,
          );
          continue;
        }

        const patternSnapshot = JSON.stringify(candidate.pattern);

        if (this.cfg.autoApprove) {
          // Write immediately and record as approved
          this.writeSkillToDisk(result.proposedOutputPath, result.skillContent);
          const proposal = this.crystallizationStore.create({
            patternId: candidate.patternId,
            skillName: result.skillName,
            skillContent: result.skillContent,
            patternSnapshot,
          });
          this.crystallizationStore.approve(proposal.id, result.proposedOutputPath);
          proposed++;
        } else {
          // Store as pending, awaiting human approval
          this.crystallizationStore.create({
            patternId: candidate.patternId,
            skillName: result.skillName,
            skillContent: result.skillContent,
            patternSnapshot,
          });
          proposed++;
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

  approveProposal(proposalId: string): ApproveResult {
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

    // Re-validate before writing
    const validation = this.validator.validate(proposal.skillContent);
    if (!validation.valid) {
      return {
        success: false,
        message: `Validation failed: ${validation.violations.join("; ")}`,
      };
    }

    // Determine output path
    const outputDir = this.cfg.outputDir.replace(/^~/, process.env["HOME"] ?? "~");
    const outputPath = `${outputDir}/${proposal.skillName}/SKILL.md`;

    try {
      this.writeSkillToDisk(outputPath, proposal.skillContent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to write skill: ${msg}` };
    }

    const updated = this.crystallizationStore.approve(proposalId, outputPath);
    if (!updated) {
      return { success: false, message: "Failed to update proposal status" };
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
