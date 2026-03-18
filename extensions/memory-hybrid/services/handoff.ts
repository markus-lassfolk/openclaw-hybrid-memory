/**
 * OCTAVE-style Structured Handoff Service (Issue #615)
 *
 * Utilities for creating, serializing, parsing, and validating structured
 * handoff artifacts emitted by subagents upon task completion.
 *
 * Replaces unstructured prose summaries with typed, schema-validated blocks
 * that preserve critical details across context resets and agent handoffs.
 *
 * Phase 1: Zero-dependency schema (no octave-mcp pip package required).
 */

import type {
  HandoffBlock,
  HandoffArtifact,
  HandoffArtifactType,
  HandoffEnvelope,
  HandoffStatus,
  CreateHandoffInput,
} from "../types/handoff-types.js";

export type { HandoffBlock, HandoffArtifact, HandoffArtifactType, HandoffStatus, HandoffEnvelope };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new HandoffBlock with auto-populated generated_at timestamp.
 * All fields are required except rollback and generated_at.
 */
export function createHandoff(input: CreateHandoffInput): HandoffBlock {
  return {
    ...input,
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Serialization — YAML
// ---------------------------------------------------------------------------

/** Serialize a string array as YAML list lines with given indent. */
function serializeStringList(items: string[], indent: string): string {
  if (items.length === 0) return `${indent}[]\n`;
  return items.map((item) => `${indent}- ${yamlQuote(item)}\n`).join("");
}

/** Serialize artifact list as YAML sequence. */
function serializeArtifacts(artifacts: HandoffArtifact[], indent: string): string {
  if (artifacts.length === 0) return `${indent}[]\n`;
  return artifacts
    .map((a) => {
      const lines: string[] = [`${indent}- type: ${a.type}\n`, `${indent}  ref: ${yamlQuote(a.ref)}\n`];
      if (a.branch) lines.push(`${indent}  branch: ${a.branch}\n`);
      if (a.description) lines.push(`${indent}  description: ${yamlQuote(a.description)}\n`);
      return lines.join("");
    })
    .join("");
}

/**
 * Wrap a string in YAML double-quotes if it contains special chars,
 * otherwise emit as a bare scalar.
 */
function yamlQuote(value: string): string {
  // Needs quoting if it contains: : # & * ? | > ! ' " % @ ` or starts with whitespace
  const needsQuotes = /[:#&*?|>!'"%@`\n\r]/.test(value) || value.startsWith(" ") || value.startsWith("-");
  if (!needsQuotes) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Serialize a HandoffBlock to a YAML fenced code block string.
 * The output is suitable for embedding in agent prose or markdown files.
 *
 * Example output:
 * ```yaml
 * handoff:
 *   task_id: forge-pr583-fix
 *   goal: "Fix the cap"
 *   status: completed
 *   ...
 * ```
 */
export function serializeHandoff(block: HandoffBlock): string {
  const i = "  "; // 2-space indent
  const lines: string[] = [
    "```yaml\n",
    "handoff:\n",
    `${i}task_id: ${block.task_id}\n`,
    `${i}goal: ${yamlQuote(block.goal)}\n`,
    `${i}status: ${block.status}\n`,
    `${i}completed:\n`,
    serializeStringList(block.completed, `${i}${i}`),
    `${i}pending:\n`,
    serializeStringList(block.pending, `${i}${i}`),
    `${i}risks:\n`,
    serializeStringList(block.risks, `${i}${i}`),
    `${i}artifacts:\n`,
    serializeArtifacts(block.artifacts, `${i}${i}`),
    `${i}verification:\n`,
    serializeStringList(block.verification, `${i}${i}`),
  ];

  if (block.rollback) {
    lines.push(`${i}rollback: ${yamlQuote(block.rollback)}\n`);
  }
  if (block.generated_at) {
    lines.push(`${i}generated_at: ${block.generated_at}\n`);
  }

  lines.push("```\n");
  return lines.join("");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Result of attempting to parse a handoff block from text. */
export interface HandoffParseResult {
  ok: true;
  block: HandoffBlock;
  errors: [];
}
export interface HandoffParseError {
  ok: false;
  block: null;
  errors: string[];
}
export type HandoffParseOutcome = HandoffParseResult | HandoffParseError;

/** Extract the raw YAML content from a ```yaml ... ``` fence in agent output. */
export function extractYamlFence(text: string): string | null {
  const match = text.match(/```ya?ml\n([\s\S]*?)```/);
  return match ? match[1] : null;
}

/** Parse a raw YAML string as a HandoffBlock (lightweight, no external dep). */
export function parseHandoffYaml(yaml: string): HandoffParseOutcome {
  const errors: string[] = [];

  // Extract lines under "handoff:" key
  const lines = yaml.split("\n");
  const handoffIdx = lines.findIndex((l) => l.trimStart().startsWith("handoff:"));
  if (handoffIdx === -1) {
    return { ok: false, block: null, errors: ["Missing top-level 'handoff:' key"] };
  }

  // Collect indented content after "handoff:"
  const handoffIndent = lines[handoffIdx].match(/^(\s*)/)?.[1].length ?? 0;
  const bodyLines = lines.slice(handoffIdx + 1).filter((l) => {
    if (l.trim() === "") return false;
    const lineIndent = l.match(/^(\s*)/)?.[1].length ?? 0;
    return lineIndent > handoffIndent;
  });

  function getScalar(key: string): string | null {
    const re = new RegExp(`^\\s+${key}:\\s*(.*)$`);
    for (const line of bodyLines) {
      const m = line.match(re);
      if (m) return stripYamlQuotes(m[1].trim());
    }
    return null;
  }

  function getList(key: string): string[] {
    const result: string[] = [];
    let inList = false;
    for (const line of bodyLines) {
      if (new RegExp(`^\\s+${key}:`).test(line)) {
        inList = true;
        const inline = line.replace(new RegExp(`^\\s+${key}:\\s*`), "").trim();
        if (inline && inline !== "[]") result.push(stripYamlQuotes(inline));
        continue;
      }
      if (inList) {
        const itemMatch = line.match(/^\s+- (.*)/);
        if (itemMatch) {
          result.push(stripYamlQuotes(itemMatch[1].trim()));
          continue;
        }
        // New key at same or lower indent ends the list
        if (/^\s+\w+:/.test(line)) break;
      }
    }
    return result;
  }

  const task_id = getScalar("task_id");
  const goal = getScalar("goal");
  const status = getScalar("status") as HandoffStatus | null;

  if (!task_id) errors.push("Missing required field: task_id");
  if (!goal) errors.push("Missing required field: goal");
  if (!status) errors.push("Missing required field: status");

  const validStatuses: HandoffStatus[] = ["completed", "failed", "partial", "escalate"];
  if (status && !validStatuses.includes(status)) {
    errors.push(`Invalid status '${status}'. Must be one of: ${validStatuses.join(", ")}`);
  }

  if (errors.length > 0) {
    return { ok: false, block: null, errors };
  }

  const artifacts = parseArtifacts(bodyLines);

  const block: HandoffBlock = {
    task_id: task_id!,
    goal: goal!,
    status: status!,
    completed: getList("completed"),
    pending: getList("pending"),
    risks: getList("risks"),
    artifacts,
    verification: getList("verification"),
    rollback: getScalar("rollback") ?? undefined,
    generated_at: getScalar("generated_at") ?? undefined,
  };

  return { ok: true, block, errors: [] };
}

/** Parse artifact sequence from YAML body lines. */
function parseArtifacts(bodyLines: string[]): HandoffArtifact[] {
  const artifacts: HandoffArtifact[] = [];
  let inArtifacts = false;
  let current: Partial<HandoffArtifact> | null = null;

  function flushArtifact(): void {
    if (current?.type && current?.ref) {
      artifacts.push(current as HandoffArtifact);
    }
    current = null;
  }

  for (const line of bodyLines) {
    if (/^\s+artifacts:/.test(line)) {
      inArtifacts = true;
      continue;
    }
    if (inArtifacts) {
      // New top-level key ends artifact section
      if (/^\s{2}\w+:/.test(line) && !/^\s{4}/.test(line) && !/^\s{2}-/.test(line)) {
        flushArtifact();
        break;
      }
      // New list item
      const newItemMatch = line.match(/^\s{4}-\s+type:\s*(\S+)/);
      if (newItemMatch) {
        flushArtifact();
        current = { type: newItemMatch[1] as HandoffArtifactType };
        continue;
      }
      if (current) {
        const refMatch = line.match(/^\s+ref:\s*(.*)/);
        if (refMatch) {
          current.ref = stripYamlQuotes(refMatch[1].trim());
          continue;
        }
        const branchMatch = line.match(/^\s+branch:\s*(.*)/);
        if (branchMatch) {
          current.branch = stripYamlQuotes(branchMatch[1].trim());
          continue;
        }
        const descMatch = line.match(/^\s+description:\s*(.*)/);
        if (descMatch) {
          current.description = stripYamlQuotes(descMatch[1].trim());
          continue;
        }
      }
    }
  }
  flushArtifact();
  return artifacts;
}

/** Strip surrounding YAML double-quotes from a scalar value. */
function stripYamlQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

/**
 * Parse a HandoffBlock from raw agent output text.
 * Extracts the YAML fence and validates all required fields.
 */
export function parseHandoffFromText(text: string): HandoffParseOutcome {
  const yaml = extractYamlFence(text);
  if (!yaml) {
    return { ok: false, block: null, errors: ["No YAML fence (```yaml ... ```) found in text"] };
  }
  return parseHandoffYaml(yaml);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a HandoffBlock object (already parsed).
 * Returns array of validation error messages (empty = valid).
 */
export function validateHandoff(block: HandoffBlock): string[] {
  const errors: string[] = [];

  if (!block.task_id || block.task_id.trim() === "") errors.push("task_id must be non-empty");
  if (!block.goal || block.goal.trim() === "") errors.push("goal must be non-empty");

  const validStatuses: HandoffStatus[] = ["completed", "failed", "partial", "escalate"];
  if (!validStatuses.includes(block.status)) {
    errors.push(`status '${block.status}' must be one of: ${validStatuses.join(", ")}`);
  }

  if (!Array.isArray(block.completed)) errors.push("completed must be an array");
  if (!Array.isArray(block.pending)) errors.push("pending must be an array");
  if (!Array.isArray(block.risks)) errors.push("risks must be an array");
  if (!Array.isArray(block.artifacts)) errors.push("artifacts must be an array");
  if (!Array.isArray(block.verification)) errors.push("verification must be an array");

  for (const [i, artifact] of (block.artifacts ?? []).entries()) {
    if (!artifact.type) errors.push(`artifacts[${i}].type is required`);
    if (!artifact.ref || artifact.ref.trim() === "") errors.push(`artifacts[${i}].ref must be non-empty`);
  }

  // Warn if completed with no completed items and no verification
  if (block.status === "completed" && block.completed.length === 0) {
    errors.push("status is 'completed' but completed[] is empty");
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Active-Task integration helpers
// ---------------------------------------------------------------------------

/**
 * Format a HandoffBlock as a one-line summary suitable for ACTIVE-TASK.md
 * "Next:" or "Handoff:" fields.
 */
export function formatHandoffSummary(block: HandoffBlock): string {
  const parts: string[] = [`[${block.status.toUpperCase()}] ${block.goal}`];
  if (block.completed.length > 0) {
    parts.push(
      `Completed: ${block.completed[0]}${block.completed.length > 1 ? ` (+${block.completed.length - 1} more)` : ""}`,
    );
  }
  if (block.pending.length > 0) {
    parts.push(`Pending: ${block.pending.length} item(s)`);
  }
  if (block.risks.length > 0) {
    parts.push(`Risks: ${block.risks.join("; ")}`);
  }
  return parts.join(" | ");
}
