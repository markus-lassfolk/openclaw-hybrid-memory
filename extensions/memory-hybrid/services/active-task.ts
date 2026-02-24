/**
 * Active Task Working Memory Service
 *
 * Parses, reads, and writes ACTIVE-TASK.md — a structured working memory file
 * that persists in-progress task state across session restarts and context compaction.
 *
 * File format:
 * ```markdown
 * ## Active Tasks
 * ### [label]: [description]
 * - **Branch:** fix/something
 * - **Status:** In progress
 * - **Subagent:** session-key
 * - **Next:** what to do next
 * - **Started:** ISO timestamp
 * - **Updated:** ISO timestamp
 *
 * ## Completed
 * ...
 * ```
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Valid task statuses */
export const ACTIVE_TASK_STATUSES = [
  "In progress",
  "Waiting",
  "Stalled",
  "Failed",
  "Done",
] as const;
export type ActiveTaskStatus = (typeof ACTIVE_TASK_STATUSES)[number];

/** Non-terminal statuses (still active) */
const ACTIVE_STATUSES: Set<ActiveTaskStatus> = new Set([
  "In progress",
  "Waiting",
  "Stalled",
  "Failed",
]);

/** Structured task entry */
export interface ActiveTaskEntry {
  /** Short unique identifier (e.g. "forge-99", "deploy-prod") */
  label: string;
  /** Human-readable description */
  description: string;
  /** Git branch if applicable */
  branch?: string;
  /** Current status */
  status: ActiveTaskStatus;
  /** Stash or commit reference */
  stashCommit?: string;
  /** Subagent session key if applicable */
  subagent?: string;
  /** What to do next */
  next?: string;
  /** ISO-8601 timestamp when task was started */
  started: string;
  /** ISO-8601 timestamp when task was last updated */
  updated: string;
  /** Whether task is flagged as stale (not updated in >staleHours) */
  stale?: boolean;
}

/** Result of parsing ACTIVE-TASK.md */
export interface ActiveTaskFile {
  /** Active (non-Done) tasks */
  active: ActiveTaskEntry[];
  /** Completed tasks (in ## Completed section) */
  completed: ActiveTaskEntry[];
  /** Raw content of the file */
  raw: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse a single field line: `- **FieldName:** value` */
function parseFieldLine(line: string): { field: string; value: string } | null {
  const match = line.match(/^-\s+\*\*([^:]+):\*\*\s*(.*)/);
  if (!match) return null;
  return { field: match[1].trim(), value: match[2].trim() };
}

/** Parse task block lines into an ActiveTaskEntry */
function parseTaskBlock(header: string, lines: string[]): ActiveTaskEntry | null {
  // Header format: `### [label]: description` or `### label: description`
  const headerMatch = header.match(/^###\s+\[?([^\]:\n]+)\]?:\s*(.+)/);
  if (!headerMatch) return null;

  const label = headerMatch[1].trim();
  const description = headerMatch[2].trim();

  const entry: Partial<ActiveTaskEntry> & { label: string; description: string } = {
    label,
    description,
    status: "In progress",
    started: new Date().toISOString(),
    updated: new Date().toISOString(),
  };

  for (const line of lines) {
    const parsed = parseFieldLine(line);
    if (!parsed) continue;
    const { field, value } = parsed;
    switch (field.toLowerCase()) {
      case "branch":
        entry.branch = value || undefined;
        break;
      case "status":
        if (ACTIVE_TASK_STATUSES.includes(value as ActiveTaskStatus)) {
          entry.status = value as ActiveTaskStatus;
        }
        break;
      case "stash/commit":
      case "stash":
      case "commit":
        entry.stashCommit = value || undefined;
        break;
      case "subagent":
        entry.subagent = value || undefined;
        break;
      case "next":
        entry.next = value || undefined;
        break;
      case "started":
        entry.started = value || new Date().toISOString();
        break;
      case "updated":
        entry.updated = value || new Date().toISOString();
        break;
    }
  }

  return entry as ActiveTaskEntry;
}

/** Parse a full ACTIVE-TASK.md file content */
export function parseActiveTaskFile(content: string): ActiveTaskFile {
  const lines = content.split("\n");
  const active: ActiveTaskEntry[] = [];
  const completed: ActiveTaskEntry[] = [];

  let inSection: "active" | "completed" | "other" = "other";
  let currentHeader: string | null = null;
  let currentLines: string[] = [];

  function flushTask(): void {
    if (!currentHeader) return;
    const entry = parseTaskBlock(currentHeader, currentLines);
    if (!entry) return;
    if (inSection === "completed" || entry.status === "Done") {
      completed.push(entry);
    } else {
      active.push(entry);
    }
    currentHeader = null;
    currentLines = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Section headers
    if (trimmed === "## Active Tasks") {
      flushTask();
      inSection = "active";
      continue;
    }
    if (trimmed === "## Completed") {
      flushTask();
      inSection = "completed";
      continue;
    }
    // Other h2 headers reset section
    if (trimmed.startsWith("## ") && trimmed !== "## Active Tasks" && trimmed !== "## Completed") {
      flushTask();
      inSection = "other";
      continue;
    }

    // Task headers (h3)
    if (trimmed.startsWith("### ")) {
      flushTask();
      currentHeader = trimmed;
      currentLines = [];
      continue;
    }

    // Accumulate field lines under current task
    if (currentHeader && (trimmed.startsWith("- **") || trimmed === "")) {
      currentLines.push(trimmed);
    }
  }

  // Don't forget the last task
  flushTask();

  return { active, completed, raw: content };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Serialize a single ActiveTaskEntry to markdown block */
export function serializeTaskEntry(entry: ActiveTaskEntry): string {
  const lines: string[] = [`### [${entry.label}]: ${entry.description}`];
  if (entry.branch) lines.push(`- **Branch:** ${entry.branch}`);
  lines.push(`- **Status:** ${entry.status}`);
  if (entry.stashCommit) lines.push(`- **Stash/Commit:** ${entry.stashCommit}`);
  if (entry.subagent) lines.push(`- **Subagent:** ${entry.subagent}`);
  if (entry.next) lines.push(`- **Next:** ${entry.next}`);
  lines.push(`- **Started:** ${entry.started}`);
  lines.push(`- **Updated:** ${entry.updated}`);
  return lines.join("\n");
}

/** Serialize all tasks back to full ACTIVE-TASK.md content */
export function serializeActiveTaskFile(
  active: ActiveTaskEntry[],
  completed: ActiveTaskEntry[],
): string {
  const parts: string[] = ["# ACTIVE-TASK.md — Working Memory\n"];

  parts.push("## Active Tasks\n");
  if (active.length === 0) {
    parts.push("_No active tasks._\n");
  } else {
    for (const entry of active) {
      parts.push(serializeTaskEntry(entry));
      parts.push("");
    }
  }

  if (completed.length > 0) {
    parts.push("## Completed\n");
    for (const entry of completed) {
      parts.push(serializeTaskEntry(entry));
      parts.push("");
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Stale detection
// ---------------------------------------------------------------------------

/**
 * Flag tasks that have not been updated in more than `staleHours` hours.
 * Returns new array with `stale` property set.
 */
export function detectStaleTasks(
  tasks: ActiveTaskEntry[],
  staleHours: number,
): ActiveTaskEntry[] {
  const now = Date.now();
  const staleMs = staleHours * 60 * 60 * 1000;
  return tasks.map((t) => {
    const updatedMs = new Date(t.updated).getTime();
    const isStale = !isNaN(updatedMs) && now - updatedMs > staleMs;
    return { ...t, stale: isStale };
  });
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/** Read and parse ACTIVE-TASK.md from disk. Returns null if file doesn't exist. */
export async function readActiveTaskFile(
  filePath: string,
  staleHours = 24,
): Promise<ActiveTaskFile | null> {
  if (!existsSync(filePath)) return null;
  try {
    const content = await readFile(filePath, "utf-8");
    const parsed = parseActiveTaskFile(content);
    // Apply stale detection to active tasks
    parsed.active = detectStaleTasks(parsed.active, staleHours);
    return parsed;
  } catch {
    return null;
  }
}

/** Write tasks back to ACTIVE-TASK.md. Creates parent directories as needed. */
export async function writeActiveTaskFile(
  filePath: string,
  active: ActiveTaskEntry[],
  completed: ActiveTaskEntry[],
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const content = serializeActiveTaskFile(active, completed);
  await writeFile(filePath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Task mutations
// ---------------------------------------------------------------------------

/**
 * Add or update a task entry. If an entry with the same label exists, update it.
 * Otherwise, append a new entry.
 */
export function upsertTask(
  active: ActiveTaskEntry[],
  entry: ActiveTaskEntry,
): ActiveTaskEntry[] {
  const idx = active.findIndex((t) => t.label === entry.label);
  if (idx >= 0) {
    const updated = [...active];
    updated[idx] = { ...active[idx], ...entry, updated: new Date().toISOString() };
    return updated;
  }
  return [...active, { ...entry, updated: new Date().toISOString() }];
}

/**
 * Mark a task as Done, remove from active list, return entry (for flush to memory).
 */
export function completeTask(
  active: ActiveTaskEntry[],
  label: string,
): { updated: ActiveTaskEntry[]; completed: ActiveTaskEntry | null } {
  const idx = active.findIndex((t) => t.label === label);
  if (idx < 0) return { updated: active, completed: null };
  const task: ActiveTaskEntry = {
    ...active[idx],
    status: "Done",
    updated: new Date().toISOString(),
  };
  const updated = active.filter((_, i) => i !== idx);
  return { updated, completed: task };
}

// ---------------------------------------------------------------------------
// Injection summary builder
// ---------------------------------------------------------------------------

/**
 * Build a compact injection block for the active task working memory.
 * Budget-capped to `maxTokens` (approximate — 4 chars ≈ 1 token).
 */
export function buildActiveTaskInjection(
  tasks: ActiveTaskEntry[],
  maxTokens: number,
): string {
  const activeTasks = tasks.filter((t) => ACTIVE_STATUSES.has(t.status));
  if (activeTasks.length === 0) return "";

  const lines: string[] = ["<active-tasks>", "In-progress tasks from ACTIVE-TASK.md:"];

  // Budget: ~4 chars per token, minus header/footer overhead
  const charBudget = maxTokens * 4 - 60;
  let used = 0;

  for (const task of activeTasks) {
    const staleFlag = task.stale ? " ⚠️ STALE" : "";
    const summary = [
      `- [${task.label}] ${task.description} (${task.status}${staleFlag})`,
    ];
    if (task.next) summary.push(`  Next: ${task.next}`);
    if (task.subagent) summary.push(`  Subagent: ${task.subagent}`);
    const block = summary.join("\n");
    if (used + block.length > charBudget) break;
    lines.push(block);
    used += block.length + 1;
  }

  lines.push("</active-tasks>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Flush to daily memory log
// ---------------------------------------------------------------------------

/**
 * Append completed task summary to `memory/YYYY-MM-DD.md`.
 * Creates the file if it doesn't exist.
 */
export async function flushCompletedTaskToMemory(
  task: ActiveTaskEntry,
  memoryDir: string,
): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const filePath = join(memoryDir, `${date}.md`);

  await mkdir(memoryDir, { recursive: true });

  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist yet — that's fine
  }

  const summary = [
    `## Completed Task: [${task.label}] ${task.description}`,
    `- **Status:** Done`,
    `- **Started:** ${task.started}`,
    `- **Completed:** ${task.updated}`,
    ...(task.branch ? [`- **Branch:** ${task.branch}`] : []),
    ...(task.subagent ? [`- **Subagent:** ${task.subagent}`] : []),
    "",
  ].join("\n");

  const newContent = existing
    ? existing.trimEnd() + "\n\n" + summary
    : `# Memory Log — ${date}\n\n` + summary;

  await writeFile(filePath, newContent, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Re-exports of types used in other modules
// ---------------------------------------------------------------------------
export { ACTIVE_STATUSES };
