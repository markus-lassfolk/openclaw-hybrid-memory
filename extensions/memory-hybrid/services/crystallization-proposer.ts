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
import { PatternDetector } from "./pattern-detector.js";
import { SkillCrystallizer } from "./skill-crystallizer.js";
import { SkillValidator } from "./skill-validator.js";

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
  private readonly detector: PatternDetector | null;
  private readonly crystallizer: SkillCrystallizer;
  private readonly validator: SkillValidator;

  constructor(
    private readonly workflowStore: WorkflowStore | null,
    private readonly crystallizationStore: CrystallizationStore,
    private readonly cfg: CrystallizationConfig,
  ) {
    this.detector = workflowStore ? new PatternDetector(workflowStore, crystallizationStore, cfg) : null;
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
  runCycle(opts?: { autoApproveOverride?: boolean }): ProposeResult {
    if (!this.cfg.enabled) {
      return { proposed: 0, skipped: 0, reasons: ["Crystallization is disabled"] };
    }
    if (!this.detector) {
      return { proposed: 0, skipped: 0, reasons: ["Crystallization workflow store is not available"] };
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
    const autoApprove = opts?.autoApproveOverride ?? this.cfg.autoApprove;

    for (const candidate of candidates) {
      try {
        const result = this.crystallizer.crystallize({
          patternId: candidate.patternId,
          evidenceHash: candidate.evidenceHash,
          pattern: candidate.pattern,
        });

        // Static analysis gate
        const validation = this.validator.validate(result.skillContent);
        const patternSnapshot = JSON.stringify(candidate.pattern);

        if (!validation.valid) {
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
            rejectionReason: `validator: ${validation.violations.slice(0, 3).join("; ")}`,
          });
          skipped++;
          reasons.push(
            `Rejected '${result.skillName}': failed validation — ${validation.violations.slice(0, 2).join("; ")}`,
          );
          continue;
        }

        // Store as validated proposal (awaiting human approval)
        const proposal = this.crystallizationStore.create({
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
          status: "validated",
        });

        if (autoApprove) {
          // Auto-approve path still requires the same caps and validator already ran above.
          const currentApprovedCount = this.crystallizationStore.count("approved");
          if (currentApprovedCount >= this.cfg.maxCrystallized) {
            skipped++;
            reasons.push(`Skipped '${result.skillName}': maxCrystallized limit reached (${this.cfg.maxCrystallized})`);
            continue;
          }
          const approved = this.crystallizationStore.approve(proposal.id);
          if (approved) {
            const outputPath = this.computeOutputPath(approved.skillName);
            this.writeSkillToDisk(outputPath, this.injectInstallMetadata(approved, outputPath));
            this.crystallizationStore.install(approved.id, outputPath);
          }
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
  // approveProposal — write skill to disk and mark as approved
  // -------------------------------------------------------------------------

  approveProposal(
    proposalId: string,
    overrides?: { name?: string; category?: string; recommendedOutput?: "SKILL.md only" },
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

    // Check maxCrystallized limit before approving
    const approvedCount = this.crystallizationStore.count("approved");
    if (approvedCount >= this.cfg.maxCrystallized) {
      return {
        success: false,
        message: `maxCrystallized limit reached (${this.cfg.maxCrystallized})`,
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

    const desiredName = overrides?.name?.trim() ? overrides.name.trim() : proposal.skillName;
    const safeName = desiredName.replace(/[^a-z0-9_-]/gi, "-").replace(/^\.+/, "");
    const desiredCategory = overrides?.category?.trim() ? overrides.category.trim() : proposal.category;
    const desiredRecommendedOutput = overrides?.recommendedOutput ?? proposal.recommendedOutput;

    const { skillContent: rewrittenContent, proposalCardJson: rewrittenCardJson } = this.applyOverridesToDraft(
      proposal,
      {
        skillName: safeName,
        category: desiredCategory,
        recommendedOutput: desiredRecommendedOutput,
      },
    );

    // Approve in DB first (source of truth), then write to disk, then mark installed.
    const updated = this.crystallizationStore.approve(proposalId, {
      skillName: safeName,
      skillContent: rewrittenContent,
      category: desiredCategory,
      recommendedOutput: desiredRecommendedOutput,
      proposalCardJson: rewrittenCardJson,
    });
    if (!updated) {
      return { success: false, message: "Failed to update proposal status" };
    }

    const outputPath = this.computeOutputPath(updated.skillName);

    try {
      this.writeSkillToDisk(outputPath, this.injectInstallMetadata(updated, outputPath));
      // Mark installed and keep output path link.
      this.crystallizationStore.install(updated.id, outputPath);
      // Supersede older installed approvals for the same pattern (best-effort).
      this.trySupersedeOlderInstalls(updated.patternId, updated.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Approved but failed to write skill: ${msg}` };
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

    const updated = this.crystallizationStore.reject(proposalId, reason);
    if (!updated) {
      return { success: false, message: "Failed to update proposal status" };
    }

    return { success: true, message: `Proposal '${proposalId}' rejected` };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private computeOutputPath(skillName: string): string {
    const outputDir = this.cfg.outputDir.replace(/^~/, getEnv("HOME") || homedir());
    return `${outputDir}/${skillName}/SKILL.md`;
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
      recommendedOutput?: "SKILL.md only";
    },
  ): { skillContent: string; proposalCardJson?: string } {
    let skillContent = proposal.skillContent;
    if (overrides.skillName && overrides.skillName !== proposal.skillName) {
      // Update title line only (keep the rest intact and concise).
      skillContent = skillContent.replace(new RegExp(`^#\\s+${escapeRegExp(proposal.skillName)}\\s*$`, "m"), `# ${overrides.skillName}`);
    }
    if (overrides.category) {
      skillContent = skillContent.replace(/^\*\*Category:\*\* .+$/m, `**Category:** ${overrides.category}`);
    }
    if (overrides.recommendedOutput) {
      skillContent = skillContent.replace(
        /^\*\*Recommended output:\*\* .+$/m,
        `**Recommended output:** ${overrides.recommendedOutput}`,
      );
    }

    let proposalCardJson = proposal.proposalCardJson;
    if (proposalCardJson) {
      try {
        const parsed = JSON.parse(proposalCardJson) as Record<string, unknown>;
        parsed.name = overrides.skillName;
        if (overrides.category) parsed.category = overrides.category;
        if (overrides.recommendedOutput) parsed.recommended_output = overrides.recommendedOutput;
        proposalCardJson = JSON.stringify(parsed);
      } catch {
        // leave as-is
      }
    }

    return { skillContent, proposalCardJson };
  }

  private injectInstallMetadata(proposal: { id: string; patternId: string; evidenceHash: string; skillContent: string }, outputPath: string): string {
    const header = `<!-- openclaw:skill-proposal id=${proposal.id} pattern_id=${proposal.patternId} evidence_hash=${proposal.evidenceHash} output_path=${outputPath} -->`;
    if (proposal.skillContent.startsWith("<!-- openclaw:skill-proposal")) {
      return proposal.skillContent;
    }
    return `${header}\n\n${proposal.skillContent}`;
  }

  private trySupersedeOlderInstalls(patternId: string, supersededBy: string): void {
    try {
      const existing = this.crystallizationStore.list({ skillName: undefined, limit: 50 }).filter((p) => p.patternId === patternId);
      for (const p of existing) {
        if (p.id === supersededBy) continue;
        if (p.status === "installed" || p.status === "approved") {
          this.crystallizationStore.supersede(p.id, supersededBy);
        }
      }
    } catch {
      // best-effort; ignore
    }
  }

  private writeSkillToDisk(outputPath: string, skillContent: string): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, skillContent, "utf-8");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
