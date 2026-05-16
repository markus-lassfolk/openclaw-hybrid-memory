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
import { dirname, resolve } from "node:path";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { WorkflowPattern, WorkflowStore } from "../backends/workflow-store.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { stripLeadingHtmlComments } from "../utils/text.js";
import { capturePluginError } from "./error-reporter.js";
import {
  GeneratedSkillValidationService,
  detailSkillProposalValidation,
  summarizeSkillProposalValidation,
} from "./generated-skill-validation.js";
import { PatternDetector } from "./pattern-detector.js";
import { SkillCrystallizer } from "./skill-crystallizer.js";

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
  private readonly validator: GeneratedSkillValidationService;

  constructor(
    private readonly workflowStore: WorkflowStore | null,
    private readonly crystallizationStore: CrystallizationStore,
    private readonly cfg: CrystallizationConfig,
  ) {
    this.detector = workflowStore ? new PatternDetector(workflowStore, crystallizationStore, cfg) : null;
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
  runCycle(opts?: { autoApproveOverride?: boolean }): ProposeResult {
    if (!this.cfg.enabled) {
      return {
        proposed: 0,
        skipped: 0,
        reasons: ["Crystallization is disabled"],
      };
    }
    if (!this.detector) {
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
          this.writeSkillToDisk(outputPath, this.injectInstallMetadata(approval.proposal, outputPath));
          this.crystallizationStore.install(approval.proposal.id, outputPath);
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
  // approveProposal — write skill to disk and mark as approved
  // -------------------------------------------------------------------------

  approveProposal(
    proposalId: string,
    opts?: {
      overrideWarnings?: boolean;
      name?: string;
      category?: string;
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
    const safeName = desiredName.replace(/[^a-z0-9_-]/gi, "-").replace(/^\.+/, "");
    const desiredCategory = opts?.category?.trim() ? opts.category.trim() : proposal.category;
    const desiredRecommendedOutput = opts?.recommendedOutput ?? proposal.recommendedOutput;

    const { skillContent: rewrittenContent, proposalCardJson: rewrittenCardJson } = this.applyOverridesToDraft(
      proposal,
      {
        skillName: safeName,
        category: desiredCategory,
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
      this.writeSkillToDisk(outputPath, this.injectInstallMetadata(updated, outputPath));
      // Mark installed and keep output path link.
      this.crystallizationStore.install(updated.id, outputPath);
      // Supersede older installed approvals for the same pattern (best-effort).
      this.trySupersedeOlderInstalls(updated.patternId, updated.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Approved but failed to write skill: ${msg}`,
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
      recommendedOutput?: "SKILL.md only";
    },
  ): { skillContent: string; proposalCardJson?: string } {
    let skillContent = proposal.skillContent;
    if (overrides.skillName && overrides.skillName !== proposal.skillName) {
      skillContent = skillContent.replace(
        new RegExp(`^#\\s+${escapeRegExp(proposal.skillName)}\\s*$`, "m"),
        `# ${overrides.skillName}`,
      );
      skillContent = patchOpeningYamlField(skillContent, "name", overrides.skillName);
    }
    if (overrides.category) {
      skillContent = skillContent.replace(/^\*\*Category:\*\* .+$/m, `**Category:** ${overrides.category}`);
      skillContent = patchOpeningYamlField(skillContent, "category", overrides.category);
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
      const existing = this.crystallizationStore
        .list({ skillName: undefined, limit: 50 })
        .filter((p) => p.patternId === patternId);
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

/** Update a key in the opening YAML frontmatter block (after optional leading HTML comment). */
function patchOpeningYamlField(skillContent: string, key: string, value: string): string {
  let body = skillContent;
  let prefix = "";
  const commentMatch = body.match(/^<!--[\s\S]*?-->\s*\n*/);
  if (commentMatch) {
    prefix = commentMatch[0];
    body = body.slice(commentMatch[0].length);
  }
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return skillContent;
  const inner = m[1];
  const re = new RegExp(`^${escapeRegExp(key)}:\\s*.*$`, "m");
  const nextInner = re.test(inner) ? inner.replace(re, `${key}: ${value}`) : `${key}: ${value}\n${inner}`;
  const newBlock = `---\n${nextInner}\n---\n`;
  return prefix + body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, newBlock);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
