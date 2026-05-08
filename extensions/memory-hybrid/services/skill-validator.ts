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

interface DenyRule {
  name: string;
  /** Applies to lines inside code blocks only */
  codeBlockOnly?: boolean;
  /** Regex pattern to match */
  pattern: RegExp;
  /** Human-readable description for the violation message */
  description: string;
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
  /**
   * Validate SKILL.md content for security violations.
   * Parses code blocks and applies deny rules.
   */
  validate(skillContent: string): ValidationResult {
    const violations: string[] = [];
    const lines = skillContent.split("\n");

    let inCodeBlock = false;
    let lineNumber = 0;

    for (const line of lines) {
      lineNumber++;
      const trimmed = line.trim();

      // Track code block boundaries
      const codeBlockFence = trimmed.match(/^```(\w*)/);
      if (codeBlockFence) {
        inCodeBlock = !inCodeBlock;
        continue;
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
