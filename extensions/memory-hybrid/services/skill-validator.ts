/**
 * Skill Validator — static security analysis for generated SKILL.md content (Issue #208).
 *
 * DENY patterns:
 *  - Shell execution commands in code blocks (bash, sh, exec, eval, system, etc.)
 *  - Credential access patterns (env vars with KEY/SECRET/TOKEN/PASSWORD, ssh commands)
 *  - Network calls (curl, wget, fetch, http.*)
 *  - File system writes outside the skill directory (rm, mv, write to absolute paths)
 *
 * The validator is intentionally conservative: false positives are acceptable,
 * false negatives (allowing dangerous content) are not.
 *
 * Required section taxonomy is shared with GeneratedSkillValidationService via
 * config/skill-sections.ts (issues #1375, #1366, #1408).
 */

import { ACTION_VERB_PATTERN } from "../utils/constants.js";
import { stripLeadingHtmlComments } from "../utils/text.js";
import {
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_BYTES_SAFE,
  utf8ByteLength,
} from "../config/skill-size-limits.js";
import {
  CATEGORY_FRONTMATTER_KEYS,
  MAX_SKILL_LINES,
  getSectionTaxonomy,
  type SectionTaxonomyOverrides,
} from "../config/skill-sections.js";
import { parseSkillFrontmatterKeys } from "./skill-frontmatter.js";
export {
  CATEGORY_FRONTMATTER_KEYS,
  DEFAULT_REQUIRED_SECTIONS,
  MAX_SKILL_LINES,
  getSectionTaxonomy,
  type SectionTaxonomyOverrides,
} from "../config/skill-sections.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface ValidationResult {
  valid: boolean;
  violations: string[];
}

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------
const MAX_FENCED_BLOCK_LINES = 80;
const MAX_TRANSCRIPT_LIKE_RATIO = 0.4;
const MAX_TOOL_BLOB_LINES = 40;

interface DenyRule {
  name: string;
  /** Applies to lines inside code blocks only */
  codeBlockOnly?: boolean;
  /** Regex pattern to match */
  pattern: RegExp;
  /** Human-readable description for the violation message */
  description: string;
}

/**
 * Case-insensitive PEM private-key block detector.
 * Shared with generated-skill-validation.ts and procedure-promotion-policy.ts (Issue #1382).
 * Character class includes digits and allows trailing words (e.g. "BLOCK" in PGP markers).
 * Matches: -----BEGIN PRIVATE KEY-----, -----BEGIN RSA PRIVATE KEY-----,
 *          -----BEGIN PGP PRIVATE KEY BLOCK-----, -----begin private key-----, etc.
 */
export const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Za-z0-9 ]*PRIVATE KEY[A-Za-z0-9 ]*-----/i;

/**
 * Private IP address pattern (RFC 1918 ranges).
 * Shared with generated-skill-validation.ts and procedure-promotion-policy.ts.
 * Matches: 10.x.x.x, 172.16-31.x.x, 192.168.x.x (four-octet private IPs).
 * Loopback (127.x) is intentionally excluded — it reveals nothing about network topology
 * and causes noisy false positives on health-check examples (Issue #1385).
 */
export const PRIVATE_IP_PATTERN = /\b(?:10\.\d{1,3}\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)\d{1,3}\.\d{1,3}\b/;

/** Default placeholder email domains used by {@link buildNonPlaceholderEmailPattern}. */
export const DEFAULT_PLACEHOLDER_EMAIL_DOMAINS = ["example.com", "localhost", "test.com", "example.org"];

/**
 * Build a regex that matches real-looking email addresses while excluding placeholder domains.
 * Domain entries are regex-escaped so arbitrary strings are safe to pass.
 * If the allow-list is empty, returns a pattern that flags all valid-looking email addresses.
 * @param allowList - domains to treat as safe placeholders (default: {@link DEFAULT_PLACEHOLDER_EMAIL_DOMAINS})
 */
export function buildNonPlaceholderEmailPattern(allowList: string[]): RegExp {
  const escaped = allowList
    .filter((d) => d.length > 0)
    .map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (escaped.length === 0) {
    // No placeholder domains: flag all valid-looking email addresses.
    return /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i;
  }
  return new RegExp(`\\b[A-Za-z0-9._%+-]+@(?!(?:${escaped})(?![A-Za-z0-9.-]))[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b`, "i");
}

const SECRET_PATTERNS: Array<[name: string, pattern: RegExp, description: string]> = [
  ["private-key-block", PEM_PRIVATE_KEY_PATTERN, "Private key block detected"],
  [
    "bearer-token",
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
    "Bearer token-like credential detected (must not be copied into skills)",
  ],
  [
    "api-key-assignment",
    /\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|private[_-]?key)\s*[:=]\s*[^\s,;}{[\]]+/i,
    "Credential assignment pattern detected (must not be copied into skills)",
  ],
  [
    "high-entropy-token",
    /\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/i,
    "High-entropy token pattern detected (must not be copied into skills)",
  ],
];

/** Real-looking emails only; allows example.com, localhost, test.com, example.org placeholders. */
export const NON_PLACEHOLDER_EMAIL_PATTERN = buildNonPlaceholderEmailPattern(DEFAULT_PLACEHOLDER_EMAIL_DOMAINS);

/**
 * Build the private-context pattern list. Accepts an optional email pattern override so that
 * operators can supply a custom placeholder-domain allow-list (Issue #1383).
 */
function buildPrivateContextPatterns(
  emailPattern: RegExp,
): Array<[name: string, pattern: RegExp, description: string]> {
  return [
    ["private-ip", PRIVATE_IP_PATTERN, "Private IP / host inventory detected (replace with placeholders)"],
    [
      "home-path-linux",
      /(?:^|[\s"'=:])\/home\/(?!user\/|runner\/|ubuntu\/)[^\s"'/:]+\/[^\s"']+/,
      "User-specific /home/... path detected (replace with placeholders)",
    ],
    [
      "home-path-macos",
      /(?:^|[\s"'=:])\/Users\/(?!user\/|runner\/)[^\s"'/:]+\/[^\s"']+/,
      "User-specific /Users/... path detected (replace with placeholders)",
    ],
    [
      "tilde-home-path",
      // Negative lookahead (?!\.) has been removed — dotfile paths (e.g. ~/.ssh, ~/.aws)
      // are the most sensitive and must be flagged, not excluded (Issue #1384).
      /(?:^|[\s"'=:])~\/[^\s"']+/,
      "Tilde home path detected (replace with placeholders; avoid personal paths in skills)",
    ],
    ["email-address", emailPattern, "Non-example email address detected (remove or replace with example.com)"],
  ];
}

const DENY_RULES: DenyRule[] = [
  // Shell execution
  {
    name: "shell-eval",
    codeBlockOnly: true,
    pattern: new RegExp("\\bev" + "al\\s*[\\(\\$" + "'\"`]", "i"),
    description: "ev" + "al() or ev" + "al$(...) in code block — arbitrary code execution",
  },
  {
    name: "shell-exec-func",
    codeBlockOnly: true,
    pattern: /\bexec\s*\(/i,
    description: "exec() function call in code block",
  },
  {
    name: "shell-system",
    codeBlockOnly: true,
    pattern: /\bsystem\s*\(/i,
    description: "system() call in code block",
  },
  {
    name: "shell-spawn",
    codeBlockOnly: true,
    pattern: /\bspawn\s*\(/i,
    description: "spawn() call in code block — process creation",
  },
  // Credential access
  {
    name: "credential-env-secret",
    codeBlockOnly: true,
    pattern: /\$\{?(?:\w*(?:API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY|ACCESS_KEY|AUTH|CREDENTIAL)\w*)\b/i,
    description: "Environment variable referencing a credential secret",
  },
  {
    name: "ssh-command",
    codeBlockOnly: true,
    pattern: /\bssh\s+(-\w+\s+)*\w+@/i,
    description: "SSH command with user@host in code block",
  },
  // Network calls
  {
    name: "curl-call",
    codeBlockOnly: true,
    pattern: /\bcurl\s+/i,
    description: "curl network call in code block",
  },
  {
    name: "wget-call",
    codeBlockOnly: true,
    pattern: /\bwget\s+/i,
    description: "wget network call in code block",
  },
  {
    name: "http-fetch",
    codeBlockOnly: true,
    pattern: /\bfetch\s*\(\s*['"]https?:\/\//i,
    description: "HTTP fetch() call to external URL in code block",
  },
  // Filesystem writes to absolute/dangerous paths
  {
    name: "rm-rf",
    codeBlockOnly: true,
    pattern: /\brm\s+-[rf]+\s+\/|rm\s+-[rf]+\s+~\//i,
    description: "Recursive deletion from absolute or home path in code block",
  },
  {
    name: "write-to-etc",
    codeBlockOnly: true,
    pattern: />\s*\/etc\//i,
    description: "Redirect write to /etc/ in code block",
  },
  {
    name: "write-to-root",
    codeBlockOnly: true,
    pattern: />\s*\/(?:usr|bin|sbin|root|boot)\//i,
    description: "Redirect write to system path in code block",
  },
  // Dangerous JavaScript/TypeScript in non-SKILL context
  {
    name: "require-fs",
    codeBlockOnly: true,
    pattern: /require\s*\(\s*['"](?:child_process|fs|path)['"]\)/i,
    description: "require('child_process'|'fs'|'path') in code block",
  },
  {
    name: "import-child-process",
    codeBlockOnly: true,
    pattern: /import\s+.*from\s+['"]child_process['"]/i,
    description: "import from 'child_process' in code block",
  },
];

// ---------------------------------------------------------------------------
// SkillValidator
// ---------------------------------------------------------------------------

export class SkillValidator {
  private readonly privateContextPatterns: Array<[name: string, pattern: RegExp, description: string]>;
  private readonly sectionTaxonomyOverrides?: SectionTaxonomyOverrides;

  /**
   * @param options.emailPattern - custom non-placeholder email regex; defaults to
   *   {@link NON_PLACEHOLDER_EMAIL_PATTERN}. Build with {@link buildNonPlaceholderEmailPattern}.
   * @param options.sectionTaxonomyOverrides - optional per-category section taxonomy overrides
   *   (passed through from CrystallizationProposer; Issue #1408).
   */
  constructor(options?: { emailPattern?: RegExp; sectionTaxonomyOverrides?: SectionTaxonomyOverrides }) {
    this.privateContextPatterns = buildPrivateContextPatterns(options?.emailPattern ?? NON_PLACEHOLDER_EMAIL_PATTERN);
    this.sectionTaxonomyOverrides = options?.sectionTaxonomyOverrides;
  }

  /**
   * Validate generated SKILL.md content for:
   * - security violations (deny rules inside code blocks)
   * - required structure/sections for reusable workflows
   * - anti-log-dumping guardrails (transcript/log blobs)
   */
  validate(skillContent: string): ValidationResult {
    const violations: string[] = [];
    const rawBytes = utf8ByteLength(skillContent);
    if (rawBytes > MAX_SKILL_FILE_BYTES) {
      return {
        valid: false,
        violations: [
          `Skill exceeds OpenClaw loader byte limit (${rawBytes} > ${MAX_SKILL_FILE_BYTES}). Shrink SKILL.md or move deterministic detail into bounded sidecars.`,
        ],
      };
    }

    const normalizedSkillContent = stripLeadingHtmlComments(skillContent);
    const lines = normalizedSkillContent.split("\n");

    if (lines.length > MAX_SKILL_LINES) {
      violations.push(
        `Skill exceeds ${MAX_SKILL_LINES} lines (${lines.length}). Summarize logs/transcripts into workflow phases and checklists.`,
      );
    }

    const skillBytes = Buffer.byteLength(normalizedSkillContent, "utf8");
    if (skillBytes > MAX_SKILL_FILE_BYTES_SAFE) {
      violations.push(
        `Skill exceeds ${MAX_SKILL_FILE_BYTES_SAFE} bytes (${skillBytes}). Use progressive disclosure and bounded sidecars.`,
      );
    }

    if (/\*\*\w+\*\*\s*\{/.test(normalizedSkillContent)) {
      violations.push("Legacy raw tool-call dump format detected (**tool** {json}); summarize into workflow phases.");
    }

    if (/\b[A-Za-z]:\\[^\s/]+/.test(normalizedSkillContent) || /\b[A-Za-z]:\\/.test(normalizedSkillContent)) {
      violations.push("Windows-style paths are not allowed; use forward-slash paths only.");
    }

    const bodyLower = normalizedSkillContent.toLowerCase();
    const usesProcedure = /\bprocedure\b/.test(bodyLower);
    const usesWorkflow = /\bworkflow\b/.test(bodyLower);
    if (usesProcedure && usesWorkflow && /\bthis procedure\b|\bthe procedure\b/i.test(normalizedSkillContent)) {
      violations.push(
        "Mixed procedure/workflow terminology: prefer workflow (user-facing) and recipe (machine-readable sidecar).",
      );
    }

    // Secrets are a hard-fail regardless of where they appear.
    for (const [name, pattern, desc] of SECRET_PATTERNS) {
      if (pattern.test(skillContent)) {
        violations.push(`[${name}] ${desc}`);
      }
    }

    // Reject private context that should not be embedded into reusable skills.
    for (const [name, pattern, desc] of this.privateContextPatterns) {
      if (pattern.test(skillContent)) {
        violations.push(`[${name}] ${desc}`);
      }
    }

    // Required frontmatter + sections are enforced to prevent transcript-dumps.
    const frontmatter = parseFrontmatter(lines);
    if (!frontmatter.present) {
      violations.push("Missing required YAML frontmatter (--- ... ---) with name/description/category/provenance.");
    } else {
      const keys = frontmatter.keys;
      for (const req of ["name", "description"] as const) {
        if (!keys.has(req)) violations.push(`Frontmatter missing required field: ${req}`);
      }
      const desc = keys.get("description") ?? "";
      if (desc.length > MAX_SKILL_DESCRIPTION_CHARS) {
        violations.push(`Frontmatter description exceeds ${MAX_SKILL_DESCRIPTION_CHARS} characters.`);
      }
      const hasCategory =
        CATEGORY_FRONTMATTER_KEYS.some((key) => keys.has(key)) ||
        keys.has("metadata.category") ||
        keys.has("metadata.tags") ||
        keys.has("metadata.type");
      if (!hasCategory) violations.push("Frontmatter missing required category (or equivalent: tags/type/kind).");
      const hasProvenance =
        keys.has("provenance") ||
        keys.has("metadata.provenance") ||
        keys.has("generated_from") ||
        keys.has("generatedfrom") ||
        keys.has("source") ||
        keys.has("source_pattern_id") ||
        keys.has("source_procedure_id");
      if (!hasProvenance) violations.push("Frontmatter missing provenance/generated-from metadata reference.");
    }

    const headings = parseH2Headings(lines);
    // Use the shared taxonomy from config/skill-sections.ts so that both
    // SkillValidator and GeneratedSkillValidationService check the same sections
    // (issues #1375, #1408).
    const frontmatterCategory = frontmatter.present ? getFrontmatterCategory(frontmatter.keys) : undefined;
    const requiredSections = getSectionTaxonomy(frontmatterCategory, this.sectionTaxonomyOverrides);

    for (const section of requiredSections) {
      if (!hasHeadingAlias(headings, section.aliases)) {
        violations.push(`Missing required section: ${section.label}`);
      }
    }

    // Examples must include at least one compact real example (avoid placeholders).
    const examplesBody = extractSectionBody(lines, headings, ["examples"]);
    if (examplesBody !== null) {
      const examplesTrimmed = examplesBody.trim();
      if (examplesTrimmed.length === 0 || !containsConcreteExample(examplesBody)) {
        violations.push(
          "Examples section must include at least one compact, concrete example (not just placeholders).",
        );
      }
    }

    let inCodeBlock = false;
    let fenceChar: "`" | "~" | null = null;
    let fenceOpenLen = 0;
    let currentFenceStartLine = 0;
    let currentFenceLines = 0;
    let lineNumber = 0;
    let codeBlockLineCount = 0;
    let transcriptToolOrStackLineCount = 0;
    let toolBlobLikeLineCount = 0;

    for (const line of lines) {
      lineNumber++;
      const trimmed = line.trim();

      // Track fenced blocks; closing delimiter must match opener (``` vs ~~~) and length (CommonMark).
      // Closing lines must be fence + optional whitespace only — not ```json mid-block, etc.
      const fenceStart = trimmed.match(/^(`{3,}|~{3,})/);
      if (fenceStart) {
        const marker = fenceStart[1];
        const ch = marker[0] as "`" | "~";
        const len = marker.length;
        const afterMarker = trimmed.slice(marker.length);
        const isCloseLine = /^\s*$/.test(afterMarker);
        if (!inCodeBlock) {
          inCodeBlock = true;
          fenceChar = ch;
          fenceOpenLen = len;
          currentFenceStartLine = lineNumber;
          currentFenceLines = 0;
          const contextLine = findPreviousNonEmptyLine(lines, lineNumber - 2);
          if (!contextLine || /^#{1,6}\s+/.test(contextLine) || /^(`{3,}|~{3,})/.test(contextLine)) {
            violations.push(
              `Line ${lineNumber}: [codeblock-context] Code/log snippet must have a preceding explanatory sentence (avoid raw dumps).`,
            );
          }
          continue;
        }
        if (isCloseLine && fenceChar === ch && len >= fenceOpenLen) {
          if (currentFenceLines > MAX_FENCED_BLOCK_LINES) {
            violations.push(
              `Line ${currentFenceStartLine}: [codeblock-size] Fenced code/log block has ${currentFenceLines} lines (max ${MAX_FENCED_BLOCK_LINES}). Summarize instead.`,
            );
          }
          inCodeBlock = false;
          fenceChar = null;
          fenceOpenLen = 0;
          continue;
        }
      }

      if (inCodeBlock) {
        currentFenceLines++;
        codeBlockLineCount++;
      } else {
        const transcriptLike = /^\s*(assistant|user|tool|system)\s*:/i.test(line);
        const toolBlobLike = looksLikeToolOrJsonBlob(trimmed);
        const stackTraceLike = looksLikeStackTraceLine(trimmed);
        if (toolBlobLike) toolBlobLikeLineCount++;
        if (transcriptLike || toolBlobLike || stackTraceLike) transcriptToolOrStackLineCount++;
      }

      // Apply rules
      for (const rule of DENY_RULES) {
        if (rule.codeBlockOnly && !inCodeBlock) continue;
        if (rule.pattern.test(line)) {
          violations.push(`Line ${lineNumber}: [${rule.name}] ${rule.description} — "${trimmed.slice(0, 80)}"`);
        }
      }

      // Additional check: any code block containing shell-like content should
      // not have backtick command substitution
      if (inCodeBlock && /\$\([^)]+\)/.test(line)) {
        violations.push(
          `Line ${lineNumber}: [shell-subst] Command substitution $(...) in code block — "${trimmed.slice(0, 80)}"`,
        );
      }
    }

    if (inCodeBlock && currentFenceLines > MAX_FENCED_BLOCK_LINES) {
      violations.push(
        `Line ${currentFenceStartLine}: [codeblock-size] Fenced code/log block has ${currentFenceLines} lines (max ${MAX_FENCED_BLOCK_LINES}) and no closing fence at end of file. Summarize instead.`,
      );
    }

    const rawLikeRatio =
      lines.length === 0 ? 0 : (codeBlockLineCount + transcriptToolOrStackLineCount) / Math.max(1, lines.length);
    if (rawLikeRatio > MAX_TRANSCRIPT_LIKE_RATIO) {
      violations.push(
        `[log-dump-guard] ${Math.round(rawLikeRatio * 100)}% of lines look like raw transcript/log/code. Summarize and keep snippets short.`,
      );
    }
    if (toolBlobLikeLineCount > MAX_TOOL_BLOB_LINES) {
      violations.push(
        `[tool-blob-guard] Detected ${toolBlobLikeLineCount} tool/JSON-like lines outside code blocks. Summarize tool-call blobs into workflow steps and checklists instead of pasting raw dumps.`,
      );
    }

    return {
      valid: violations.length === 0,
      violations,
    };
  }

  /**
   * Quick check: returns true if content passes validation.
   */
  isValid(skillContent: string): boolean {
    return this.validate(skillContent).valid;
  }
}

// ---------------------------------------------------------------------------
// Markdown helpers (lightweight, intentionally conservative)
// ---------------------------------------------------------------------------

export function normalizeHeading(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/\s-]+/gu, "")
    .replace(/\s+/g, " ");
}

export function parseH2Headings(lines: string[]): Array<{ raw: string; normalized: string; line: number }> {
  const out: Array<{ raw: string; normalized: string; line: number }> = [];
  let inFence = false;
  let fenceChar: "`" | "~" | null = null;
  let fenceOpenLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    const fenceStart = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceStart) {
      const marker = fenceStart[1];
      const ch = marker[0] as "`" | "~";
      const len = marker.length;
      const afterMarker = trimmed.slice(marker.length);
      const isCloseLine = /^\s*$/.test(afterMarker);
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        fenceOpenLen = len;
        continue;
      }
      if (isCloseLine && fenceChar === ch && len >= fenceOpenLen) {
        inFence = false;
        fenceChar = null;
        fenceOpenLen = 0;
        continue;
      }
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (!match) continue;
    const raw = match[1];
    out.push({ raw, normalized: normalizeHeading(raw), line: i + 1 });
  }
  return out;
}

export function hasHeadingAlias(headings: Array<{ normalized: string }>, aliases: string[]): boolean {
  const normalizedAliases = aliases.map(normalizeHeading);
  return headings.some((h) => normalizedAliases.includes(h.normalized));
}

function extractSectionBody(
  lines: string[],
  headings: Array<{ normalized: string; line: number }>,
  aliases: string[],
): string | null {
  const normalizedAliases = new Set(aliases.map(normalizeHeading));
  const start = headings.find((h) => normalizedAliases.has(h.normalized));
  if (!start) return null;
  const afterStartIndex = start.line; // 1-based line number; body starts after it
  const next = headings.filter((h) => h.line > start.line).sort((a, b) => a.line - b.line)[0];
  const endLine = next ? next.line - 1 : lines.length;
  return lines.slice(afterStartIndex, endLine).join("\n").trim();
}

function containsConcreteExample(examplesBody: string): boolean {
  const lines = examplesBody.split("\n").map((l) => l.trim());
  const nonEmpty = lines.filter(Boolean);

  const listOk = nonEmpty.some((l) => {
    if (!/^(?:[-*+]|\d+\.)\s+\S/.test(l)) return false;
    if (/\b(?:tbd|todo|placeholder|example here|fill in)\b/i.test(l)) return false;
    if (l.length < 18) return false;
    if (!ACTION_VERB_PATTERN.test(l)) return false;
    return true;
  });
  if (listOk) return true;

  return nonEmpty.some((l) => {
    if (/^(?:[-*+]|\d+\.)\s/.test(l)) return false;
    if (l.length < 40) return false;
    if (!ACTION_VERB_PATTERN.test(l)) return false;
    const words = l.split(/\s+/).filter(Boolean);
    if (words.length < 4) return false;
    if (l.length > 15 && l === l.toUpperCase()) return false;
    if (/\b(?:tbd|todo|placeholder|example here|fill in)\b/i.test(l)) return false;
    return true;
  });
}

function findPreviousNonEmptyLine(lines: string[], startIndex: number): string | null {
  for (let i = startIndex; i >= 0; i--) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return null;
}

function unquoteFrontmatterValue(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function getFrontmatterCategory(keys: Map<string, string>): string | undefined {
  const metaCategory = keys.get("metadata.category");
  if (metaCategory) return unquoteFrontmatterValue(metaCategory);
  for (const key of CATEGORY_FRONTMATTER_KEYS) {
    const value = keys.get(key);
    if (value) return unquoteFrontmatterValue(value);
  }
  return undefined;
}

function parseFrontmatter(lines: string[]): {
  present: boolean;
  keys: Map<string, string>;
  endLine: number;
} {
  const originalContent = lines.join("\n");
  const body = stripLeadingHtmlComments(originalContent);
  const bodyLines = body.split("\n");
  const strippedLineCount = originalContent.split("\n").length - bodyLines.length;
  if (bodyLines[0]?.trim() !== "---") {
    return { present: false, keys: new Map(), endLine: -1 };
  }
  let endIdx = -1;
  for (let i = 1; i < bodyLines.length; i++) {
    if (bodyLines[i]?.trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return { present: false, keys: new Map(), endLine: -1 };
  const block = bodyLines.slice(1, endIdx).join("\n");
  const keys = parseSkillFrontmatterKeys(block);
  return { present: true, keys, endLine: endIdx + 1 + strippedLineCount };
}

function looksLikeToolOrJsonBlob(trimmed: string): boolean {
  if (trimmed.length === 0) return false;
  if (/^diff --git\b/i.test(trimmed) || /^@@\s+[-+]\d+/i.test(trimmed)) return true;
  if (/^\s*\{/.test(trimmed) || /^\s*\[/.test(trimmed)) {
    if (trimmed.includes(`":`) || trimmed.includes("':")) return true;
  }
  if (/"tool"\s*:|"toolCall"|tool_call_id|"args"\s*:|"content"\s*:/i.test(trimmed)) return true;
  if (/^\s*Command:\s+/i.test(trimmed) || /^\s*Output:\s+/i.test(trimmed)) return true;
  return false;
}

function looksLikeStackTraceLine(trimmed: string): boolean {
  if (trimmed.length === 0) return false;
  if (/^\s*at\s+\S+/.test(trimmed)) return true;
  if (/^(?:Caused by:|Exception in thread|Traceback \(most recent call last\):)/i.test(trimmed)) return true;
  return false;
}
