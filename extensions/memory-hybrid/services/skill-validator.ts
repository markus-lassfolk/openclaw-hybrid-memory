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
 */

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

const MAX_SKILL_LINES = 300;
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

const SECRET_PATTERNS: Array<[name: string, pattern: RegExp, description: string]> = [
  ["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/, "Private key block detected"],
  [
    "bearer-token",
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
    "Bearer token-like credential detected (must not be copied into skills)",
  ],
  [
    "api-key-assignment",
    /\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|private[_-]?key)\s*[:=]\s*[^\s,;}{\[\]]+/i,
    "Credential assignment pattern detected (must not be copied into skills)",
  ],
  [
    "high-entropy-token",
    /\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/i,
    "High-entropy token pattern detected (must not be copied into skills)",
  ],
];

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
  /**
   * Validate generated SKILL.md content for:
   * - security violations (deny rules inside code blocks)
   * - required structure/sections for reusable workflows
   * - anti-log-dumping guardrails (transcript/log blobs)
   */
  validate(skillContent: string): ValidationResult {
    const violations: string[] = [];
    const lines = skillContent.split("\n");

    if (lines.length > MAX_SKILL_LINES) {
      violations.push(
        `Skill exceeds ${MAX_SKILL_LINES} lines (${lines.length}). Summarize logs/transcripts into workflow phases and checklists.`,
      );
    }

    // Secrets are a hard-fail regardless of where they appear.
    for (const [name, pattern, desc] of SECRET_PATTERNS) {
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
      const hasCategory =
        keys.has("category") || keys.has("categories") || keys.has("tags") || keys.has("type") || keys.has("kind");
      if (!hasCategory) violations.push("Frontmatter missing required category (or equivalent: tags/type/kind).");
      const hasProvenance =
        keys.has("provenance") ||
        keys.has("generated_from") ||
        keys.has("generatedfrom") ||
        keys.has("source") ||
        keys.has("source_pattern_id") ||
        keys.has("source_procedure_id");
      if (!hasProvenance) violations.push("Frontmatter missing provenance/generated-from metadata reference.");
    }

    const headings = parseH2Headings(lines);
    const requiredSections: Array<{ id: string; label: string; aliases: string[] }> = [
      { id: "when", label: "When to Activate", aliases: ["when to activate", "when to use", "trigger"] },
      {
        id: "dont",
        label: "Do Not Use When",
        aliases: ["do not use when", "when not to use", "do not use", "anti-activation conditions"],
      },
      { id: "workflow", label: "Workflow", aliases: ["workflow", "steps"] },
      {
        id: "verify",
        label: "Verification / Quality Checklist",
        aliases: ["verification", "quality checklist", "validation"],
      },
      {
        id: "anti",
        label: "Anti-patterns / Known Failures",
        aliases: ["anti-patterns / known failures", "anti-patterns", "known failures"],
      },
      { id: "examples", label: "Examples", aliases: ["examples"] },
    ];

    for (const section of requiredSections) {
      if (!hasHeadingAlias(headings, section.aliases)) {
        violations.push(`Missing required section: ${section.label}`);
      }
    }

    // Examples must include at least one compact real example (avoid placeholders).
    const examplesBody = extractSectionBody(lines, headings, ["examples"]);
    if (examplesBody && !containsConcreteExample(examplesBody)) {
      violations.push("Examples section must include at least one compact, concrete example (not just placeholders).");
    }

    let inCodeBlock = false;
    let currentFenceStartLine = 0;
    let currentFenceLines = 0;
    let lineNumber = 0;
    let codeBlockLineCount = 0;
    let transcriptLikeLineCount = 0;
    let toolBlobLikeLineCount = 0;
    let stackTraceLikeLineCount = 0;

    for (const line of lines) {
      lineNumber++;
      const trimmed = line.trim();

      // Track code block boundaries
      const codeBlockFence = trimmed.match(/^```(\w*)/);
      if (codeBlockFence) {
        inCodeBlock = !inCodeBlock;
        if (inCodeBlock) {
          currentFenceStartLine = lineNumber;
          currentFenceLines = 0;
          const contextLine = findPreviousNonEmptyLine(lines, lineNumber - 2);
          if (!contextLine || /^#{1,6}\s+/.test(contextLine) || /^```/.test(contextLine)) {
            violations.push(
              `Line ${lineNumber}: [codeblock-context] Code/log snippet must have a preceding explanatory sentence (avoid raw dumps).`,
            );
          }
        } else {
          if (currentFenceLines > MAX_FENCED_BLOCK_LINES) {
            violations.push(
              `Line ${currentFenceStartLine}: [codeblock-size] Fenced code/log block has ${currentFenceLines} lines (max ${MAX_FENCED_BLOCK_LINES}). Summarize instead.`,
            );
          }
        }
        continue;
      }

      if (inCodeBlock) {
        currentFenceLines++;
        codeBlockLineCount++;
      } else {
        if (/^\s*(assistant|user|tool|system)\s*:/i.test(line)) transcriptLikeLineCount++;
        if (looksLikeToolOrJsonBlob(trimmed)) toolBlobLikeLineCount++;
        if (looksLikeStackTraceLine(trimmed)) stackTraceLikeLineCount++;
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

    const rawLikeRatio =
      lines.length === 0
        ? 0
        : (codeBlockLineCount + transcriptLikeLineCount + toolBlobLikeLineCount + stackTraceLikeLineCount) /
          Math.max(1, lines.length);
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

function normalizeHeading(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\/\s-]+/gu, "")
    .replace(/\s+/g, " ");
}

function parseH2Headings(lines: string[]): Array<{ raw: string; normalized: string; line: number }> {
  const out: Array<{ raw: string; normalized: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]?.match(/^##\s+(.+?)\s*$/);
    if (!match) continue;
    const raw = match[1];
    out.push({ raw, normalized: normalizeHeading(raw), line: i + 1 });
  }
  return out;
}

function hasHeadingAlias(
  headings: Array<{ normalized: string }>,
  aliases: string[],
): boolean {
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
  const next = headings
    .filter((h) => h.line > start.line)
    .sort((a, b) => a.line - b.line)[0];
  const endLine = next ? next.line - 1 : lines.length;
  return lines.slice(afterStartIndex, endLine).join("\n").trim();
}

function containsConcreteExample(examplesBody: string): boolean {
  const lines = examplesBody
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // Accept any bullet/numbered item that isn't an obvious placeholder.
  return lines.some((l) => {
    if (!/^[-*]|\d+\./.test(l)) return false;
    if (/\b(?:tbd|todo|placeholder|example here|fill in)\b/i.test(l)) return false;
    return l.length >= 18;
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

function parseFrontmatter(lines: string[]): { present: boolean; keys: Map<string, string>; endLine: number } {
  const keys = new Map<string, string>();
  // Only treat it as frontmatter when it starts the document (after optional leading blank lines).
  let i = 0;
  while (i < lines.length && lines[i]?.trim() === "") i++;
  if (lines[i]?.trim() !== "---") return { present: false, keys, endLine: -1 };
  i++;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") return { present: true, keys, endLine: i + 1 };
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2];
    if (!keys.has(key)) keys.set(key, value);
  }
  return { present: false, keys, endLine: -1 };
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
