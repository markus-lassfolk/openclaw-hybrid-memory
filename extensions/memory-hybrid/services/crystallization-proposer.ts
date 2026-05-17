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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { atomicWriteFile } from "../utils/atomic-write.js";
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
import { buildNonPlaceholderEmailPattern } from "./skill-validator.js";

/** When renaming, replace the first Markdown ATX H1 in the body (after frontmatter), if any. */
function replaceFirstBodyH1AfterFrontmatter(skillContent: string, newTitle: string): string {
  const stripped = stripLeadingHtmlComments(skillContent);
  const head = skillContent.slice(0, skillContent.length - stripped.length);
  let body = stripped;
  const fmMatch = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (fmMatch) {
    const frontmatter = fmMatch[0];
    body = body.slice(frontmatter.length);
    const leadingNewlineMatch = body.match(/^\r?\n/);
    const leadingNewline = leadingNewlineMatch ? leadingNewlineMatch[0] : "";
    body = body.replace(/^\r?\n/, "");
    const h1Line = /^(#[ \t]+(?!#)\S[^\r\n]*)(\r?)$/m;
    if (!h1Line.test(body)) {
      return skillContent;
    }
    return (
      head +
      frontmatter +
      leadingNewline +
      body.replace(h1Line, (_match, _oldLine: string, cr: string) => `# ${newTitle}${cr}`)
    );
  }
  const leadingNewlineMatch = body.match(/^\r?\n/);
  const leadingNewline = leadingNewlineMatch ? leadingNewlineMatch[0] : "";
  body = body.replace(/^\r?\n/, "");
  const h1Line = /^(#[ \t]+(?!#)\S[^\r\n]*)(\r?)$/m;
  if (!h1Line.test(body)) {
    return skillContent;
  }
  return head + leadingNewline + body.replace(h1Line, (_match, _oldLine: string, cr: string) => `# ${newTitle}${cr}`);
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
  errors: string[];
  messages: string[];
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
    this.validator = new GeneratedSkillValidationService(
      cfg.placeholderEmailDomains?.length
        ? { emailPattern: buildNonPlaceholderEmailPattern(cfg.placeholderEmailDomains) }
        : undefined,
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

  /**
   * Re-validate on-disk SKILL.md for every installed proposal (operator / cron hygiene).
   * Persists validation via {@link CrystallizationStore.saveValidationResult}; on `deny`, sets status `quarantined`.
   */
  rescanInstalledSkills(): RescanInstalledSkillsResult {
    const installed = this.crystallizationStore.list({ status: "installed", limit: 500 });
    let scanned = 0;
    let quarantined = 0;
    let skipped = 0;
    const errors: string[] = [];
    const messages: string[] = [];
    const outputDir = this.cfg.outputDir.replace(/^~/, getEnv("HOME") || homedir());

    for (const proposal of installed) {
      if (!proposal.outputPath?.trim()) {
        skipped++;
        messages.push(`Skipped ${proposal.id} (${proposal.skillName}): no outputPath`);
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
            messages.push(`Quarantined ${proposal.skillName}: ${summarizeSkillProposalValidation(validation)}`);
          } else {
            errors.push(`${proposal.id}: quarantine update failed`);
          }
        } else {
          messages.push(`OK ${proposal.skillName}: ${summarizeSkillProposalValidation(validation)}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${proposal.id}: validate failed — ${msg}`);
      }
    }

    return { scanned, quarantined, skipped, errors, messages };
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
      skillContent = replaceFirstBodyH1AfterFrontmatter(skillContent, overrides.skillName);
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
      const existing = this.crystallizationStore.listByPatternId(patternId);
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
    atomicWriteFile(outputPath, skillContent);
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
  const innerLineBreak = inner.includes("\r\n") ? "\r\n" : "\n";
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

function formatYamlFrontmatterScalar(value: string): string {
  if (value === "") return '""';

  // YAML 1.1 reserved words that must be quoted to be treated as strings
  const yamlReservedWords = new Set([
    "true",
    "false",
    "True",
    "False",
    "TRUE",
    "FALSE",
    "yes",
    "no",
    "Yes",
    "No",
    "YES",
    "NO",
    "on",
    "off",
    "On",
    "Off",
    "ON",
    "OFF",
    "null",
    "Null",
    "NULL",
    "~",
  ]);

  // Check if value is a reserved word or looks like a number
  if (yamlReservedWords.has(value) || /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) {
    return JSON.stringify(value);
  }

  if (/^[\w.-]+$/.test(value)) return value;
  return JSON.stringify(value);
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
  return m ? m[1]!.length : 0;
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
      while (k < lines.length && lines[k]!.trim() === "") k++;
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
