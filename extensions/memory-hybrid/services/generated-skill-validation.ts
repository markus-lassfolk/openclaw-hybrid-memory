import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { WorkflowPattern } from "../backends/workflow-store.js";
import {
  CATEGORY_FRONTMATTER_KEYS,
  DEFAULT_REQUIRED_SECTIONS,
  MAX_SKILL_LINES,
  type SectionTaxonomyOverrides,
} from "../config/skill-sections.js";
import { stripLeadingHtmlComments } from "../utils/text.js";
import { normalizeSkillName } from "./skill-crystallizer.js";
import { NON_PLACEHOLDER_EMAIL_PATTERN, normalizeHeading, parseH2Headings, SkillValidator } from "./skill-validator.js";

export type ValidationStageStatus = "passed" | "warn" | "failed";
export type ProposalApprovalDecision = "allow" | "allow-with-override" | "deny";

export interface SyntheticActivationCases {
  positive: string;
  negative: string;
  edge: string;
}

export type SkillFrontmatter = Record<string, string | undefined>;

interface SyntheticActivationContext {
  cases: SyntheticActivationCases;
  sourceText: string;
}

export interface SkillProposalValidationResult {
  schemaVersion: 1;
  validatedAt: string;
  overallStatus: ValidationStageStatus;
  approvalDecision: ProposalApprovalDecision;
  staticValidation: {
    status: ValidationStageStatus;
    violations: string[];
    frontmatter: SkillFrontmatter;
    safeOutputPath: string;
  };
  dryLoadValidation: {
    status: ValidationStageStatus;
    violations: string[];
    discovered: Record<string, string>;
  };
  syntheticActivationEval: {
    status: ValidationStageStatus;
    score: number;
    cases: SyntheticActivationCases;
    results: {
      positiveMatched: boolean;
      negativeMatched: boolean;
      edgeMatched: boolean;
    };
    notes: string[];
  };
  canarySession: {
    status: "not-run";
  };
}

interface ValidateGeneratedSkillInput {
  outputDir: string;
  proposedOutputPath: string;
  skillName: string;
  skillContent: string;
  pattern?: WorkflowPattern;
}

const REQUIRED_FRONTMATTER_FIELDS = ["name", "description"] as const;
// REQUIRED_SECTIONS removed: section validation is now delegated to SkillValidator which
// uses the shared alias-aware taxonomy from config/skill-sections.ts (issues #1375, #1408).
const MAX_SKILL_CHARS = 16_000;
// MAX_SKILL_LINES is imported from config/skill-sections.ts — the single source of truth
// shared with SkillValidator (issue #1366).
const TRANSCRIPT_LINE_RE = /^(?:user|assistant|system|tool):/i;
const TIMESTAMP_LINE_RE = /^\d{4}-\d{2}-\d{2}[t ](?:[0-9:.+\-]|z)+/i;
const EXPLANATION_PATTERN = /\b(?:explain|describe|summarize|review)\b/;
const NEGATION_PATTERN = /\b(?:without|do not|don't|avoid)\b/;
const SECRET_OR_PRIVATE_PATTERNS = [
  /sk-[a-z0-9]{20,}/i,
  /gh[pousr]_[a-z0-9_]{20,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  NON_PLACEHOLDER_EMAIL_PATTERN,
  /\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\/(?:Users|home)\/[^\s/]+/i,
];
const STOP_WORDS = new Set([
  "about",
  "after",
  "agent",
  "asks",
  "bound",
  "clearly",
  "does",
  "explain",
  "file",
  "follow",
  "from",
  "generated",
  "have",
  "into",
  "just",
  "only",
  "please",
  "request",
  "skill",
  "task",
  "that",
  "then",
  "this",
  "user",
  "using",
  "when",
  "with",
  "workflow",
  "without",
]);

export function parseSkillFrontmatter(skillContent: string): SkillFrontmatter {
  const body = stripLeadingHtmlComments(skillContent);
  const match = body.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const frontmatter: SkillFrontmatter = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line
      .slice(colonIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key.length > 0) frontmatter[key] = value;
  }
  return frontmatter;
}

function getFrontmatterCategory(frontmatter: SkillFrontmatter): string | undefined {
  for (const key of CATEGORY_FRONTMATTER_KEYS) {
    if (frontmatter[key]) return frontmatter[key];
  }
  return undefined;
}

export function summarizeSkillProposalValidation(result?: SkillProposalValidationResult): string {
  if (!result) return "not validated";
  const status = result.overallStatus.toUpperCase();
  const override = result.approvalDecision === "allow-with-override" ? " (override required)" : "";
  return `${status}${override}; static=${result.staticValidation.status}, dry-load=${result.dryLoadValidation.status}, activation=${result.syntheticActivationEval.status} (${result.syntheticActivationEval.score})`;
}

export function detailSkillProposalValidation(result?: SkillProposalValidationResult): string {
  if (!result) return "not validated";
  const details = [
    ...result.staticValidation.violations.map((v) => `static: ${v}`),
    ...result.dryLoadValidation.violations.map((v) => `dry-load: ${v}`),
    ...result.syntheticActivationEval.notes.map((v) => `activation: ${v}`),
  ];
  if (details.length === 0) return summarizeSkillProposalValidation(result);
  return `${summarizeSkillProposalValidation(result)}; violations: ${details.slice(0, 8).join("; ")}`;
}

export class GeneratedSkillValidationService {
  private readonly skillValidator: SkillValidator;

  constructor(private readonly sectionTaxonomyOverrides?: SectionTaxonomyOverrides) {
    this.skillValidator = new SkillValidator(sectionTaxonomyOverrides);
  }

  validate(
    input: ValidateGeneratedSkillInput,
    options?: { legacyQueuedCrystallization?: boolean },
  ): SkillProposalValidationResult {
    const validatedAt = new Date().toISOString();
    const legacy = options?.legacyQueuedCrystallization === true;
    const frontmatter = parseSkillFrontmatter(input.skillContent);
    const staticValidation = this.validateStatic(input, frontmatter, legacy);
    const dryLoadValidation = legacy
      ? ({
          status: "passed",
          violations: [],
          discovered: {},
        } as SkillProposalValidationResult["dryLoadValidation"])
      : this.validateDryLoad(input.skillContent, frontmatter, input.skillName);
    const syntheticActivationEval = legacy ? legacyBypassActivationEval() : this.evaluateActivation(input, frontmatter);
    const overallStatus: ValidationStageStatus =
      staticValidation.status === "failed" ||
      dryLoadValidation.status === "failed" ||
      syntheticActivationEval.status === "failed"
        ? "failed"
        : syntheticActivationEval.status === "warn"
          ? "warn"
          : "passed";
    const approvalDecision: ProposalApprovalDecision =
      staticValidation.status === "failed" ||
      dryLoadValidation.status === "failed" ||
      syntheticActivationEval.status === "failed"
        ? "deny"
        : syntheticActivationEval.status === "warn"
          ? "allow-with-override"
          : "allow";

    return {
      schemaVersion: 1,
      validatedAt,
      overallStatus,
      approvalDecision,
      staticValidation,
      dryLoadValidation,
      syntheticActivationEval,
      canarySession: { status: "not-run" },
    };
  }

  private validateStatic(
    input: ValidateGeneratedSkillInput,
    frontmatter: SkillFrontmatter,
    legacy: boolean,
  ): SkillProposalValidationResult["staticValidation"] {
    const violations: string[] = [];
    const safeOutputPath = resolve(input.outputDir, input.skillName, "SKILL.md");
    const proposedOutputPath = resolve(input.proposedOutputPath);

    if (input.skillContent.length > MAX_SKILL_CHARS) {
      violations.push(`Skill exceeds ${MAX_SKILL_CHARS} characters`);
    }
    if (input.skillContent.split(/\r?\n/).length > MAX_SKILL_LINES) {
      violations.push(`Skill exceeds ${MAX_SKILL_LINES} lines`);
    }
    if (!legacy) {
      for (const field of REQUIRED_FRONTMATTER_FIELDS) {
        if (!frontmatter[field] || frontmatter[field].trim().length === 0) {
          violations.push(`Missing required frontmatter field: ${field}`);
        }
      }
      if (!getFrontmatterCategory(frontmatter)) {
        violations.push("Missing required frontmatter field: category");
      }
      if (frontmatter.name && frontmatter.name !== input.skillName) {
        violations.push(`Frontmatter name '${frontmatter.name}' must match skill name '${input.skillName}'`);
      }
      if (frontmatter.name && !isApprovalSanitizedSkillName(frontmatter.name)) {
        violations.push("Frontmatter name must use letters, digits, underscores, or hyphens only");
      }
      if ((frontmatter.description ?? "").length > 280) {
        violations.push("Frontmatter description exceeds 280 characters");
      }
      // NOTE: Required-section checks have been removed from this method.
      // They are now performed by SkillValidator (called below) using the alias-aware
      // taxonomy from config/skill-sections.ts (issues #1375, #1366, #1408).
      const transcriptLineCount = input.skillContent
        .split(/\r?\n/)
        .filter((line) => TRANSCRIPT_LINE_RE.test(line.trim()) || TIMESTAMP_LINE_RE.test(line.trim())).length;
      if (transcriptLineCount >= 3) {
        violations.push("Content appears to dump raw transcript or log lines");
      }
    }
    if (!isCanonicalSkillPath(input.outputDir, proposedOutputPath, input.skillName)) {
      violations.push(`Unsafe proposed output path: ${input.proposedOutputPath}`);
    }
    for (const pattern of SECRET_OR_PRIVATE_PATTERNS) {
      if (pattern.test(input.skillContent)) {
        violations.push(`Secret/private-data pattern detected: ${pattern}`);
      }
    }
    const validatorResult = this.skillValidator.validate(input.skillContent);
    if (!validatorResult.valid) {
      for (const v of validatorResult.violations) {
        if (legacy && legacyIgnorableSkillValidatorViolation(v)) continue;
        violations.push(v);
      }
    }

    return {
      status: violations.length > 0 ? "failed" : "passed",
      violations,
      frontmatter,
      safeOutputPath,
    };
  }

  private validateDryLoad(
    skillContent: string,
    frontmatter: SkillFrontmatter,
    skillName: string,
  ): SkillProposalValidationResult["dryLoadValidation"] {
    const violations: string[] = [];
    const discovered: Record<string, string> = {};
    const tempDir = mkdtempSync(join(tmpdir(), "hm-crystallization-dry-load-"));

    try {
      const workspaceDir = join(tempDir, "workspace");
      const skillsDir = join(workspaceDir, "skills");
      const normalizedSkillName = normalizeSkillName(skillName);
      const skillDirName = isApprovalSanitizedSkillName(skillName) ? skillName : normalizedSkillName;
      const skillDir = join(skillsDir, skillDirName);
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(skillPath, skillContent, "utf-8");

      const skillDirStat = lstatSync(skillDir);
      const skillPathStat = lstatSync(skillPath);
      if (skillDirStat.isSymbolicLink() || skillPathStat.isSymbolicLink()) {
        violations.push("Dry-load skill path contains a symlink");
      }
      const skillDirReal = realpathSync(skillDir);
      const skillsDirReal = realpathSync(skillsDir);
      if (!isWithinDir(skillsDirReal, skillDirReal)) {
        violations.push("Dry-load skill directory escapes the isolated workspace");
      }

      const entries = loadDrySkillEntries(skillsDir);
      const entry = entries.find(
        (candidate) =>
          candidate.name === skillName ||
          (candidate.name ? normalizeSkillName(candidate.name) === normalizedSkillName : false),
      );
      if (!entry) {
        violations.push("Dry-load discovery did not return the generated skill");
      } else {
        Object.assign(discovered, Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)));
        if (entry.description !== frontmatter.description) {
          violations.push("Dry-load description does not match frontmatter description");
        }
        if (getFrontmatterCategory(entry) !== getFrontmatterCategory(frontmatter)) {
          violations.push("Dry-load category does not match frontmatter category");
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      violations.push(`Dry-load validation failed: ${message}`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    return {
      status: violations.length > 0 ? "failed" : "passed",
      violations,
      discovered,
    };
  }

  private evaluateActivation(
    input: ValidateGeneratedSkillInput,
    frontmatter: SkillFrontmatter,
  ): SkillProposalValidationResult["syntheticActivationEval"] {
    const { cases, sourceText } = buildSyntheticActivationContext(input, frontmatter);
    const positive = scoreActivationPrompt(cases.positive, sourceText);
    const negative = scoreActivationPrompt(cases.negative, sourceText);
    const edge = scoreActivationPrompt(cases.edge, sourceText);
    const notes: string[] = [];

    if (!positive.matched) notes.push("Positive eval did not match the skill trigger");
    if (negative.matched) notes.push("Negative eval over-triggered on an unrelated prompt");
    if (edge.matched) notes.push("Edge eval looks too broad and would likely over-trigger");

    const status: ValidationStageStatus =
      !positive.matched || negative.matched ? "failed" : edge.matched ? "warn" : "passed";
    const score = Math.round(
      ((positive.matched ? 1 : 0) + (negative.matched ? 0 : 1) + (edge.matched ? 0 : 1)) * (100 / 3),
    );

    return {
      status,
      score,
      cases,
      results: {
        positiveMatched: positive.matched,
        negativeMatched: negative.matched,
        edgeMatched: edge.matched,
      },
      notes,
    };
  }
}

function legacyIgnorableSkillValidatorViolation(violation: string): boolean {
  const normalized = violation.toLowerCase();
  return (
    normalized.includes("frontmatter") ||
    normalized.includes("required section") ||
    normalized.includes("examples section") ||
    normalized.includes("log-dump-guard") ||
    normalized.includes("tool-blob-guard") ||
    normalized.includes("codeblock-") ||
    // Matches both the old "exceeds 300 lines" message and the current shared constant.
    normalized.includes(`exceeds ${MAX_SKILL_LINES} lines`)
  );
}

function legacyBypassActivationEval(): SkillProposalValidationResult["syntheticActivationEval"] {
  return {
    status: "passed",
    score: 100,
    cases: { positive: "", negative: "", edge: "" },
    results: {
      positiveMatched: true,
      negativeMatched: false,
      edgeMatched: false,
    },
    notes: ["Skipped synthetic activation for legacy crystallization proposal (pre-template)."],
  };
}

function isCanonicalSkillPath(outputDir: string, proposedOutputPath: string, skillName: string): boolean {
  if (!isAbsolute(proposedOutputPath)) return false;

  const outputRoot = resolve(outputDir);
  const skillDir = resolve(outputRoot, skillName);
  const expected = resolve(skillDir, "SKILL.md");
  const resolvedProposed = resolve(proposedOutputPath);
  if (resolvedProposed !== expected || !isWithinDir(outputRoot, dirname(resolvedProposed))) return false;

  return existingSkillPathIsSafe(outputRoot, skillDir, expected);
}

function existingSkillPathIsSafe(outputRoot: string, skillDir: string, skillPath: string): boolean {
  for (const candidate of [outputRoot, skillDir, skillPath]) {
    if (!existsSync(candidate)) continue;
    if (lstatSync(candidate).isSymbolicLink()) return false;
  }

  const existingAnchor = existsSync(skillPath)
    ? skillPath
    : existsSync(skillDir)
      ? skillDir
      : existsSync(outputRoot)
        ? outputRoot
        : null;
  if (!existingAnchor) return true;

  const rootReal = realpathSync(outputRoot);
  const anchorReal = realpathSync(existingAnchor);
  return isWithinDir(rootReal, anchorReal);
}

function isApprovalSanitizedSkillName(value: string): boolean {
  return value.length > 0 && /^[a-z0-9_-]+$/i.test(value) && !value.startsWith(".");
}

function isWithinDir(rootDir: string, candidatePath: string): boolean {
  const rel = relative(rootDir, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function loadDrySkillEntries(skillsDir: string): SkillFrontmatter[] {
  const out: SkillFrontmatter[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    let skillContent = "";
    try {
      skillContent = readFileSync(skillPath, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Unable to read dry-load skill '${entry.name}': ${message}`);
    }
    const frontmatter = parseSkillFrontmatter(skillContent);
    if (!frontmatter.name || !frontmatter.description || !getFrontmatterCategory(frontmatter)) {
      throw new Error(`Malformed SKILL.md for ${entry.name}: missing name, description, or category frontmatter`);
    }
    out.push(frontmatter);
  }
  return out;
}

/**
 * Return the body for the first matching H2 section using the same punctuation/case
 * normalization as SkillValidator's shared taxonomy checks, respecting fenced code blocks.
 */
function extractSectionByAliases(skillContent: string, headingAliases: string[]): string {
  const normalizedAliases = new Set(headingAliases.map(normalizeHeading));
  const lines = skillContent.split(/\r?\n/);
  const headings = parseH2Headings(lines);

  const matchingHeading = headings.find((h) => normalizedAliases.has(h.normalized));
  if (!matchingHeading) return "";

  const startLine = matchingHeading.line;
  let endLine = lines.length;

  for (const heading of headings) {
    if (heading.line > startLine) {
      endLine = heading.line - 1;
      break;
    }
  }

  return lines.slice(startLine, endLine).join("\n").trim();
}

function buildSyntheticActivationContext(
  input: ValidateGeneratedSkillInput,
  frontmatter: SkillFrontmatter,
): SyntheticActivationContext {
  const positive =
    input.pattern?.exampleGoals
      .find((goal) => goal.trim().length > 0)
      ?.replace(/\s+/g, " ")
      .trim() ?? `Please use the ${input.skillName} workflow for the matching task.`;
  // Use alias-aware extraction so skills with "## When to Activate" also match (issue #1375).
  const triggerAliases = DEFAULT_REQUIRED_SECTIONS.find((s) => s.id === "trigger")?.aliases ?? [];
  const triggerSection = extractSectionByAliases(input.skillContent, triggerAliases);
  const sourceText = `${input.skillName}\n${frontmatter.description ?? ""}\n${triggerSection}`;
  // Edge prompt tokens must come from the workflow goal, not frontmatter description (often contains
  // boilerplate like "auto-crystallized"), or the edge case overlaps the trigger surface by construction.
  const keywords = [...significantWords(positive)].slice(0, 3);
  const edgePhrase = keywords.length > 0 ? keywords.join(" ") : input.skillName.replace(/-/g, " ");

  return {
    cases: {
      positive,
      negative: pickUnrelatedNegativePrompt(sourceText),
      edge: `Explain ${edgePhrase} without executing the workflow or changing files.`,
    },
    sourceText,
  };
}

/** Out-of-domain prompts for activation eval; pick one with no token overlap with the skill surface text. */
const SYNTHETIC_NEGATIVE_PROMPT_CANDIDATES: string[] = [
  "How much does an adult emperor penguin weigh on average?",
  "In what year did the Byzantine Empire fall to the Ottomans?",
  "Convert 3.5 US cups to millilitres for a baking recipe.",
  "What is the speed of sound in dry air at 20 degrees Celsius?",
  "Who composed the Goldberg Variations for harpsichord?",
  "What is the postal code for the South Georgia research station?",
];

function pickUnrelatedNegativePrompt(sourceText: string): string {
  const sourceWords = activationMatchTokens(sourceText);
  for (const candidate of SYNTHETIC_NEGATIVE_PROMPT_CANDIDATES) {
    const promptWords = activationMatchTokens(candidate);
    if ([...promptWords].every((w) => !sourceWords.has(w))) return candidate;
  }

  const stableDigest = createHash("sha256").update(sourceText.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex");
  return `${stableDigest.slice(0, 16)} ${stableDigest.slice(16, 32)}`;
}

function scoreActivationPrompt(prompt: string, sourceText: string): { matched: boolean } {
  const promptWords = activationMatchTokens(prompt);
  const sourceWords = activationMatchTokens(sourceText);
  const overlap = [...promptWords].filter((word) => sourceWords.has(word)).length;
  let score = overlap;
  const normalizedPrompt = prompt.toLowerCase();
  const normalizedSource = sourceText.toLowerCase();
  if (/\b(?:run|follow|execute|process|perform|use)\b/.test(normalizedPrompt)) score += 1;
  if (EXPLANATION_PATTERN.test(normalizedPrompt)) {
    if (EXPLANATION_PATTERN.test(normalizedSource)) score += 1;
    else score -= 1;
  }
  if (NEGATION_PATTERN.test(normalizedPrompt) && !NEGATION_PATTERN.test(normalizedSource)) {
    score -= 2;
  }
  const isShortPrompt = promptWords.size <= 2;
  const minimumOverlap = isShortPrompt ? 1 : 2;
  const minimumScore = isShortPrompt ? 1 : 2;
  return { matched: overlap >= minimumOverlap && score >= minimumScore };
}

/** Tokens for activation overlap; relax length so terse goals (e.g. "fix bug") still match. */
function activationMatchTokens(text: string): Set<string> {
  const words = significantWords(text, 3);
  for (const shortToken of significantWords(text, 2)) words.add(shortToken);
  return words;
}

function significantWords(text: string, minTokenLength = 4): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= minTokenLength && !STOP_WORDS.has(word)),
  );
}
