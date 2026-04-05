/**
 * Active Task Working Memory Service
 *
 * Parses, reads, and writes ACTIVE-TASKS.md — a structured working memory file
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

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Legacy filename before default became ACTIVE-TASKS.md; still read if the new file is missing. */
const LEGACY_ACTIVE_TASK_BASENAME = "ACTIVE-TASK.md";

/** Prefer `ACTIVE-TASKS.md`; if missing, read legacy `ACTIVE-TASK.md` in the same directory. */
function resolveActiveTaskReadPath(filePath: string): string | null {
  if (existsSync(filePath)) return filePath;
  if (basename(filePath) === "ACTIVE-TASKS.md") {
    const legacyPath = join(dirname(filePath), LEGACY_ACTIVE_TASK_BASENAME);
    if (existsSync(legacyPath)) return legacyPath;
  }
  return null;
}
import { formatDuration } from "../utils/duration.js";
import { pluginLogger } from "../utils/logger.js";
import { stableStringify } from "../utils/stable-stringify.js";
import { isOpenClawSessionLikelyPresent, looksLikeOpenClawSessionRef } from "./openclaw-session-artifact.js";

/**
 * Unparseable or invalid signal files (and abandoned atomic-write temp files) older than this are
 * deleted to prevent unbounded accumulation (issue #812). Exported for tests.
 */
export const STALE_CORRUPT_SIGNAL_MS = 5 * 60 * 1000;

async function tryDeleteStaleCorruptSignalFile(filePath: string): Promise<void> {
  try {
    const s = await stat(filePath);
    if (Date.now() - s.mtimeMs <= STALE_CORRUPT_SIGNAL_MS) return;
    await unlink(filePath);
  } catch {
    // ENOENT or other — ignore
  }
}

/** Valid task statuses */
export const ACTIVE_TASK_STATUSES = ["In progress", "Waiting", "Stalled", "Failed", "Done"] as const;
export type ActiveTaskStatus = (typeof ACTIVE_TASK_STATUSES)[number];

/** Non-terminal statuses (still active) */
const ACTIVE_STATUSES: Set<ActiveTaskStatus> = new Set(["In progress", "Waiting", "Stalled", "Failed"]);

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
  /** Whether task is flagged as stale (not updated within staleThreshold) */
  stale?: boolean;
  /** Structured handoff metadata from latest sub-agent signal */
  handoff?: ActiveTaskHandoffRef;
}

/** Structured handoff reference persisted in ACTIVE-TASKS.md */
export interface ActiveTaskHandoffRef {
  /** OCTAVE schema identifier */
  schema: string;
  /** Unique artifact id */
  artifactId: string;
  /** Signal type represented by the artifact */
  signal: TaskSignalType;
  /** Agent that emitted the signal */
  agent: string;
  /** ISO-8601 timestamp of the handoff */
  timestamp: string;
  /** SHA-256 checksum of the artifact canonical payload */
  checksum: string;
}

/** Result of parsing ACTIVE-TASKS.md */
interface ActiveTaskFile {
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
      case "session":
        if (!entry.subagent?.trim()) {
          entry.subagent = value || undefined;
        }
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
      case "handoff":
        entry.handoff = parseHandoffRef(value) ?? undefined;
        break;
    }
  }

  return entry as ActiveTaskEntry;
}

function parseHandoffRef(value: string): ActiveTaskHandoffRef | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isHandoffRef(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isHandoffRef(value: unknown): value is ActiveTaskHandoffRef {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<ActiveTaskHandoffRef>;
  return (
    typeof v.schema === "string" &&
    typeof v.artifactId === "string" &&
    typeof v.signal === "string" &&
    typeof v.agent === "string" &&
    typeof v.timestamp === "string" &&
    typeof v.checksum === "string"
  );
}

/**
 * Extract the "## Active Goals" section from the raw file content.
 * Returns the section content (without the header) or undefined if not present.
 */
function extractGoalsMirrorSection(content: string): string | undefined {
  const lines = content.split("\n");
  let inGoalsSection = false;
  const goalLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "## Active Goals") {
      inGoalsSection = true;
      continue;
    }

    // Stop at any other h2 header
    if (inGoalsSection && trimmed.startsWith("## ")) {
      break;
    }

    if (inGoalsSection) {
      goalLines.push(line);
    }
  }

  if (goalLines.length === 0) return undefined;

  // Remove leading/trailing empty lines
  while (goalLines.length > 0 && goalLines[0].trim() === "") {
    goalLines.shift();
  }
  while (goalLines.length > 0 && goalLines[goalLines.length - 1].trim() === "") {
    goalLines.pop();
  }

  return goalLines.length > 0 ? goalLines.join("\n") : undefined;
}

/** Parse a full ACTIVE-TASKS.md file content */
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

    // Task headers (h3) — only within Active Tasks / Completed sections
    if (trimmed.startsWith("### ")) {
      flushTask();
      if (inSection !== "other") {
        currentHeader = trimmed;
        currentLines = [];
      }
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
  if (entry.handoff) lines.push(`- **Handoff:** ${stableStringify(entry.handoff)}`);
  lines.push(`- **Started:** ${entry.started}`);
  lines.push(`- **Updated:** ${entry.updated}`);
  return lines.join("\n");
}

/** Serialize all tasks back to full ACTIVE-TASKS.md content */
export function serializeActiveTaskFile(
  active: ActiveTaskEntry[],
  completed: ActiveTaskEntry[],
  goalsMirrorMarkdown?: string,
): string {
  const parts: string[] = ["# ACTIVE-TASKS.md — Working Memory\n"];

  parts.push("## Active Tasks\n");
  if (active.length === 0) {
    parts.push("_No active tasks._\n");
  } else {
    for (const entry of active) {
      parts.push(serializeTaskEntry(entry));
      parts.push("");
    }
  }

  if (goalsMirrorMarkdown !== undefined) {
    parts.push("## Active Goals\n");
    parts.push("_Mirror from goal registry — do not edit by hand; refreshed on heartbeat._\n\n");
    parts.push(goalsMirrorMarkdown);
    if (!goalsMirrorMarkdown.endsWith("\n")) parts.push("\n");
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
 * Flag tasks that have not been updated in more than `staleMinutes` minutes.
 * Returns new array with `stale` property set.
 */
export function detectStaleTasks(tasks: ActiveTaskEntry[], staleMinutes: number): ActiveTaskEntry[] {
  const now = Date.now();
  const staleMs = staleMinutes * 60 * 1000;
  return tasks.map((t) => {
    const updatedMs = new Date(t.updated).getTime();
    const isStale = !Number.isNaN(updatedMs) && now - updatedMs > staleMs;
    return { ...t, stale: isStale };
  });
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse ACTIVE-TASKS.md from disk. Returns null if file doesn't exist.
 *
 * @param filePath - Absolute path to ACTIVE-TASKS.md
 * @param staleMinutes - Minutes before a task is considered stale (default: 1440 = 24h)
 */
export async function readActiveTaskFile(filePath: string, staleMinutes = 1440): Promise<ActiveTaskFile | null> {
  const pathToRead = resolveActiveTaskReadPath(filePath);
  if (!pathToRead) return null;
  try {
    const content = await readFile(pathToRead, "utf-8");
    const parsed = parseActiveTaskFile(content);
    // Apply stale detection to active tasks
    parsed.active = detectStaleTasks(parsed.active, staleMinutes);
    return parsed;
  } catch (err) {
    // Only swallow "file not found" — rethrow permission errors, malformed reads, etc.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Write tasks back to ACTIVE-TASKS.md. Creates parent directories as needed. */
export async function writeActiveTaskFile(
  filePath: string,
  active: ActiveTaskEntry[],
  completed: ActiveTaskEntry[],
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  // Preserve existing goals mirror section if present
  let goalsMirror: string | undefined;
  const pathToRead = resolveActiveTaskReadPath(filePath);
  if (pathToRead) {
    try {
      const existing = await readFile(pathToRead, "utf-8");
      goalsMirror = extractGoalsMirrorSection(existing);
    } catch {
      // Ignore read errors; write without goals section
    }
  }

  const content = serializeActiveTaskFile(active, completed, goalsMirror);
  await writeFile(filePath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Task mutations
// ---------------------------------------------------------------------------

/**
 * Add or update a task entry. If an entry with the same label exists, update it.
 * Otherwise, append a new entry.
 *
 * @param active Active task entries
 * @param entry Entry to upsert
 * @param preserveUpdated If true, use entry.updated as-is; otherwise set to current time
 */
export function upsertTask(
  active: ActiveTaskEntry[],
  entry: ActiveTaskEntry,
  preserveUpdated = false,
): ActiveTaskEntry[] {
  const idx = active.findIndex((t) => t.label === entry.label);
  const updatedTimestamp = preserveUpdated ? entry.updated : new Date().toISOString();
  if (idx >= 0) {
    const updated = [...active];
    updated[idx] = { ...active[idx], ...entry, updated: updatedTimestamp };
    return updated;
  }
  return [...active, { ...entry, updated: updatedTimestamp }];
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
export function buildActiveTaskInjection(tasks: ActiveTaskEntry[], maxTokens: number): string {
  const activeTasks = tasks.filter((t) => ACTIVE_STATUSES.has(t.status));
  if (activeTasks.length === 0) return "";

  const lines: string[] = ["<active-tasks>", "In-progress tasks from ACTIVE-TASKS.md:"];

  // Budget: ~4 chars per token, minus header/footer overhead
  const charBudget = maxTokens * 4 - 60;
  let used = 0;

  for (const task of activeTasks) {
    const staleFlag = task.stale ? " ⚠️ STALE" : "";
    const summary = [`- [${task.label}] ${task.description} (${task.status}${staleFlag})`];
    if (task.next) summary.push(`  Next: ${task.next}`);
    if (task.subagent) summary.push(`  Subagent: ${task.subagent}`);
    const block = summary.join("\n");
    if (used + block.length > charBudget) break;
    lines.push(block);
    used += block.length + 1;
  }

  // If no tasks fit within the budget, return nothing rather than an empty wrapper
  if (lines.length === 2) return "";

  lines.push("</active-tasks>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Stale warning injection builder
// ---------------------------------------------------------------------------

/**
 * Build a stale-task warning block to prepend to the agent context.
 *
 * Surfaces two kinds of information:
 * 1. Tasks where `stale === true` (flagged by `detectStaleTasks`) — shown with elapsed time.
 * 2. Any "In progress" task that has a `subagent` field — hints the agent to verify the subagent
 *    is still running via `subagents list`.
 *
 * Returns an empty string when there is nothing to report, so the caller can
 * skip injection entirely.
 *
 * @param tasks     Active tasks (must have `stale` already computed by `detectStaleTasks`).
 * @param staleMinutes Threshold used for the warning label (e.g. 1440 → shows ">24h").
 * @param maxChars Optional character budget cap (approximate — 4 chars ≈ 1 token). If provided, truncates output.
 */
export function buildStaleWarningInjection(tasks: ActiveTaskEntry[], staleMinutes: number, maxChars?: number): string {
  const staleTasks = tasks.filter((t) => t.stale);
  // Hint for any "In progress" task with a subagent — regardless of staleness.
  const inProgressWithSubagent = tasks.filter((t) => t.status === "In progress" && t.subagent);

  if (staleTasks.length === 0 && inProgressWithSubagent.length === 0) return "";

  const lines: string[] = [];
  const thresholdDisplay = formatDuration(staleMinutes);
  let usedChars = 0;

  // ── Stale task warnings ──────────────────────────────────────────────────
  if (staleTasks.length > 0) {
    const header = `⚠️ STALE ACTIVE TASKS (not updated in >${thresholdDisplay}):`;
    if (maxChars != null && usedChars + header.length > maxChars) return "";
    lines.push(header);
    usedChars += header.length + 1;

    const now = Date.now();
    for (const task of staleTasks) {
      const updatedMs = new Date(task.updated).getTime();
      const hoursAgo = Number.isNaN(updatedMs) ? "?" : Math.floor((now - updatedMs) / (60 * 60 * 1000));
      const line1 = `- [${task.label}]: ${task.description} — last updated ${task.updated} (${hoursAgo}h ago)`;
      const nextPart = task.next ? `, Next: ${task.next}` : "";
      const line2 = `  Status: ${task.status}${nextPart}`;
      const blockSize = line1.length + line2.length + 2;
      if (maxChars != null && usedChars + blockSize > maxChars) break;
      lines.push(line1);
      lines.push(line2);
      usedChars += blockSize;
    }
    const footer = "Consider: check subagent status, resume, or mark complete.";
    if (maxChars == null || usedChars + footer.length <= maxChars) {
      lines.push(footer);
      usedChars += footer.length + 1;
    }
  }

  // ── Subagent hint ────────────────────────────────────────────────────────
  if (inProgressWithSubagent.length > 0) {
    const separator = lines.length > 0 ? "\n" : "";
    const header = "💡 In-progress tasks with subagents — verify they are still running:";
    const headerSize = separator.length + header.length + 1;
    if (maxChars != null && usedChars + headerSize > maxChars) {
      return lines.join("\n");
    }
    if (lines.length > 0) lines.push("");
    lines.push(header);
    usedChars += headerSize;

    for (const task of inProgressWithSubagent) {
      const line = `- [${task.label}]: ${task.description} (subagent: ${task.subagent})`;
      if (maxChars != null && usedChars + line.length + 1 > maxChars) break;
      lines.push(line);
      usedChars += line.length + 1;
    }
    const footer = "Hint: use `subagents list` to check if these subagents are still active.";
    if (maxChars == null || usedChars + footer.length <= maxChars) {
      lines.push(footer);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Flush to daily memory log
// ---------------------------------------------------------------------------

/**
 * Append completed task summary to `memory/YYYY-MM-DD.md`.
 * Creates the file if it doesn't exist.
 */
export async function flushCompletedTaskToMemory(task: ActiveTaskEntry, memoryDir: string): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const filePath = join(memoryDir, `${date}.md`);

  await mkdir(memoryDir, { recursive: true });

  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch (err) {
    // Only swallow "file not found" — rethrow permission errors, malformed reads, etc.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      existing = "";
    } else {
      throw err;
    }
  }

  const summary = [
    `## Completed Task: [${task.label}] ${task.description}`,
    "- **Status:** Done",
    `- **Started:** ${task.started}`,
    `- **Completed:** ${task.updated}`,
    ...(task.branch ? [`- **Branch:** ${task.branch}`] : []),
    ...(task.subagent ? [`- **Subagent:** ${task.subagent}`] : []),
    ...(task.handoff ? [`- **Handoff:** ${stableStringify(task.handoff)}`] : []),
    "",
  ].join("\n");

  const newContent = existing ? `${existing.trimEnd()}\n\n${summary}` : `# Memory Log — ${date}\n\n${summary}`;

  await writeFile(filePath, newContent, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Sub-agent detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the given session key belongs to a sub-agent.
 * Sub-agents have "subagent:" somewhere in their session key.
 *
 * Examples:
 *   "agent:forge:subagent:f3d14066" → true
 *   "agent:main:main"               → false
 *   undefined                       → false
 */
export function isSubagentSession(sessionKey?: string): boolean {
  if (!sessionKey) return false;
  return sessionKey.includes("subagent:");
}

// ---------------------------------------------------------------------------
// Task signal types (file-based sub-agent → orchestrator signalling)
// ---------------------------------------------------------------------------

/** Signal types that a sub-agent can emit. */
export type TaskSignalType = "completed" | "blocked" | "escalate" | "update";

/**
 * Structured status signal that a sub-agent writes to
 * `memory/task-signals/<label>-<timestamp>-<suffix>.json` for the orchestrator to consume.
 */
export interface TaskSignal {
  /** Identifier of the emitting agent (e.g. "reaver-mqtt-auth") */
  agent: string;
  /** Human-readable task reference (e.g. "Yarbo RE: MQTT Auth") */
  taskRef: string;
  /** ISO-8601 timestamp of when the signal was emitted */
  timestamp: string;
  /** Signal type */
  signal: TaskSignalType;
  /** Short human-readable summary of what changed */
  summary: string;
  /** Optional: from/to status transition */
  statusChange?: { from: string; to: string };
  /** Optional: key findings or data points to surface */
  findings?: string[];
}

/** OCTAVE-style artifact schema identifier for task handoff files. */
export const OCTAVE_TASK_HANDOFF_SCHEMA = "octave/task-handoff@v1";

/** Typed OCTAVE-style handoff artifact persisted to disk. */
interface OctaveTaskHandoffArtifact {
  /** Schema identifier */
  schema: typeof OCTAVE_TASK_HANDOFF_SCHEMA;
  /** Artifact type */
  artifactType: "task_handoff";
  /** Schema version */
  version: 1;
  /** Unique artifact id */
  artifactId: string;
  /** Deterministic canonical JSON of payload used for checksum and diffing */
  canonical: string;
  /** SHA-256 checksum of canonical payload */
  checksum: string;
  /** Structured payload */
  payload: TaskSignal;
  /** Append-only audit trail for artifact lifecycle */
  auditTrail: Array<{
    at: string;
    by: string;
    action: "created" | "validated";
    note?: string;
  }>;
}

/**
 * A TaskSignal enriched with the path of the file it was read from,
 * so the orchestrator can delete/archive it after processing.
 */
export interface PendingTaskSignal extends TaskSignal {
  /** Absolute path of the signal file on disk */
  _filePath: string;
  /** Structured OCTAVE handoff metadata if source file used the new schema */
  _handoff?: ActiveTaskHandoffRef;
}

function isTaskSignal(signal: unknown): signal is TaskSignal {
  if (!signal || typeof signal !== "object") return false;
  const s = signal as Partial<TaskSignal>;
  return (
    typeof s.agent === "string" &&
    typeof s.taskRef === "string" &&
    typeof s.timestamp === "string" &&
    typeof s.signal === "string" &&
    typeof s.summary === "string"
  );
}

function buildCanonicalPayload(signal: TaskSignal): string {
  return stableStringify(signal);
}

function buildChecksum(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

function toHandoffRefFromArtifact(artifact: OctaveTaskHandoffArtifact): ActiveTaskHandoffRef {
  return {
    schema: artifact.schema,
    artifactId: artifact.artifactId,
    signal: artifact.payload.signal,
    agent: artifact.payload.agent,
    timestamp: artifact.payload.timestamp,
    checksum: artifact.checksum,
  };
}

export function createOctaveTaskHandoffArtifact(signal: TaskSignal): OctaveTaskHandoffArtifact {
  const canonical = buildCanonicalPayload(signal);
  const checksum = buildChecksum(canonical);
  return {
    schema: OCTAVE_TASK_HANDOFF_SCHEMA,
    artifactType: "task_handoff",
    version: 1,
    artifactId: randomUUID(),
    canonical,
    checksum,
    payload: signal,
    auditTrail: [
      {
        at: new Date().toISOString(),
        by: signal.agent,
        action: "created",
      },
    ],
  };
}

export function validateOctaveTaskHandoffArtifact(
  value: unknown,
): { valid: true; artifact: OctaveTaskHandoffArtifact } | { valid: false; reason: string } {
  if (!value || typeof value !== "object") return { valid: false, reason: "artifact is not an object" };
  const artifact = value as Partial<OctaveTaskHandoffArtifact>;
  if (artifact.schema !== OCTAVE_TASK_HANDOFF_SCHEMA) return { valid: false, reason: "schema mismatch" };
  if (artifact.artifactType !== "task_handoff") return { valid: false, reason: "artifact type mismatch" };
  if (artifact.version !== 1) return { valid: false, reason: "unsupported artifact version" };
  if (typeof artifact.artifactId !== "string" || artifact.artifactId.length === 0) {
    return { valid: false, reason: "missing artifact id" };
  }
  if (typeof artifact.canonical !== "string" || artifact.canonical.length === 0) {
    return { valid: false, reason: "missing canonical payload" };
  }
  if (typeof artifact.checksum !== "string" || artifact.checksum.length === 0) {
    return { valid: false, reason: "missing checksum" };
  }
  if (!Array.isArray(artifact.auditTrail)) return { valid: false, reason: "missing audit trail" };
  if (!isTaskSignal(artifact.payload)) return { valid: false, reason: "invalid payload" };
  const expectedCanonical = buildCanonicalPayload(artifact.payload);
  if (artifact.canonical !== expectedCanonical) return { valid: false, reason: "canonical mismatch" };
  const expectedChecksum = buildChecksum(artifact.canonical);
  if (artifact.checksum !== expectedChecksum) return { valid: false, reason: "checksum mismatch" };
  return { valid: true, artifact: artifact as OctaveTaskHandoffArtifact };
}

/**
 * Emit a structured signal file for the orchestrator to consume.
 * Should only be called by sub-agents (but is not restricted).
 *
 * @param label     Short identifier for this signal (used in filename, e.g. "forge-108")
 * @param signal    The signal payload to write
 * @param memoryDir Absolute path to the memory directory
 * @returns         Absolute path of the written signal file
 */
export async function writeTaskSignal(label: string, signal: TaskSignal, memoryDir: string): Promise<string> {
  const signalsDir = join(memoryDir, "task-signals");
  await mkdir(signalsDir, { recursive: true });
  // Sanitise label to be filesystem-safe
  const safeLabel = label.replace(/[^a-zA-Z0-9_\-]/g, "-");
  // Add timestamp + random suffix to prevent collisions (sanitized labels or same-millisecond writes)
  const timestamp = Date.now();
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  const filePath = join(signalsDir, `${safeLabel}-${timestamp}-${suffix}.json`);
  const artifact = createOctaveTaskHandoffArtifact(signal);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmpPath, JSON.stringify(artifact, null, 2), "utf-8");
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
  return filePath;
}

/**
 * Read all pending signal files from `memory/task-signals/*.json`.
 * Returns an array of signals enriched with their file paths so the
 * orchestrator can delete/archive them after processing.
 *
 * @param memoryDir Absolute path to the memory directory
 */
export async function readPendingSignals(memoryDir: string): Promise<PendingTaskSignal[]> {
  const signalsDir = join(memoryDir, "task-signals");
  if (!existsSync(signalsDir)) return [];

  let files: string[];
  try {
    files = await readdir(signalsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const resolvedSignalsDir = await realpath(signalsDir);
  const signals: PendingTaskSignal[] = [];

  // Orphaned atomic-write temps (crash after writeFile, before rename) — same age rule as corrupt JSON.
  for (const file of files) {
    if (!file.includes(".json.tmp-")) continue;
    await tryDeleteStaleCorruptSignalFile(join(signalsDir, file));
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = join(signalsDir, file);
    let resolvedFilePath: string;
    try {
      resolvedFilePath = await realpath(filePath);
    } catch {
      continue;
    }
    const rel = relative(resolvedSignalsDir, resolvedFilePath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      continue;
    }
    try {
      const raw = await readFile(resolvedFilePath, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await tryDeleteStaleCorruptSignalFile(resolvedFilePath);
        continue;
      }
      const validatedArtifact = validateOctaveTaskHandoffArtifact(parsed);
      if (validatedArtifact.valid) {
        const handoff = toHandoffRefFromArtifact(validatedArtifact.artifact);
        signals.push({
          ...validatedArtifact.artifact.payload,
          _filePath: resolvedFilePath,
          _handoff: handoff,
        });
        continue;
      }
      // Backward compatibility: legacy signal format without OCTAVE envelope.
      if (!isTaskSignal(parsed)) {
        await tryDeleteStaleCorruptSignalFile(resolvedFilePath);
        continue;
      }
      signals.push({
        ...parsed,
        _filePath: resolvedFilePath,
      });
    } catch {
      // Ignore transient read errors (race with delete, etc.)
    }
  }

  return signals;
}

/**
 * Delete a processed signal file.
 * The orchestrator calls this after applying the signal to ACTIVE-TASKS.md.
 *
 * @param filePath Absolute path of the signal file to delete (from `_filePath` field)
 */
export async function deleteSignal(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    // Ignore ENOENT — already deleted (idempotent)
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// ---------------------------------------------------------------------------
// Mtime-aware file I/O (optimistic concurrency)
// ---------------------------------------------------------------------------

/** ActiveTaskFile extended with the file's mtime in milliseconds. */
interface ActiveTaskFileWithMtime extends ActiveTaskFile {
  /** File modification time in milliseconds since epoch (from fs.stat) */
  mtime: number;
}

/**
 * Read and parse ACTIVE-TASKS.md, also capturing the file's mtime.
 * Use this when you intend to write the file back and need to detect
 * concurrent modifications (optimistic concurrency).
 *
 * @param filePath    Absolute path to ACTIVE-TASKS.md
 * @param staleMinutes Minutes before a task is considered stale (default: 1440)
 */
export async function readActiveTaskFileWithMtime(
  filePath: string,
  staleMinutes = 1440,
): Promise<ActiveTaskFileWithMtime | null> {
  const pathToRead = resolveActiveTaskReadPath(filePath);
  if (!pathToRead) return null;
  try {
    const [content, fileStat] = await Promise.all([readFile(pathToRead, "utf-8"), stat(pathToRead)]);
    const parsed = parseActiveTaskFile(content);
    parsed.active = detectStaleTasks(parsed.active, staleMinutes);
    return { ...parsed, mtime: fileStat.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write ACTIVE-TASKS.md with optimistic concurrency protection.
 *
 * Before writing, re-reads the file and checks whether its mtime has changed
 * since `knownMtime` was recorded. If the file was modified concurrently, the
 * caller-supplied `merge` callback is invoked with the freshly-read file so it
 * can re-apply its changes on top of the latest state. Up to `maxRetries`
 * attempts are made; if conflicts persist, a last-write-wins fallback write is
 * performed to avoid leaving the file untouched.
 *
 * @param filePath      Absolute path to ACTIVE-TASKS.md
 * @param active        Active task entries to write
 * @param completed     Completed task entries to write
 * @param knownMtime    The mtime observed at the last read (milliseconds)
 * @param merge         Called when a conflict is detected; receives the fresh
 *                      file state and must return the [active, completed] arrays
 *                      to write. Return null to abort the write.
 * @param maxRetries    Maximum number of retry attempts (default: 3)
 * @param staleMinutes  Minutes before a task is considered stale (default: 1440)
 * @returns             True if a write occurred; false if merge aborted the write
 */
export async function writeActiveTaskFileOptimistic(
  filePath: string,
  active: ActiveTaskEntry[],
  completed: ActiveTaskEntry[],
  knownMtime: number,
  merge: (fresh: ActiveTaskFileWithMtime) => Promise<[ActiveTaskEntry[], ActiveTaskEntry[]] | null>,
  maxRetries = 3,
  staleMinutes = 1440,
): Promise<boolean> {
  let currentActive = active;
  let currentCompleted = completed;
  let knownMtimeMutable = knownMtime;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Check current mtime before writing
    let currentMtime: number;
    try {
      const fileStat = await stat(filePath);
      currentMtime = fileStat.mtimeMs;
    } catch (err) {
      // File doesn't exist yet — no conflict possible, write directly
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        await writeActiveTaskFile(filePath, currentActive, currentCompleted);
        return true;
      }
      throw err;
    }

    if (currentMtime !== knownMtimeMutable) {
      // File was modified since we last read it — re-read and merge
      const fresh = await readActiveTaskFileWithMtime(filePath, staleMinutes);
      if (!fresh) {
        // File was deleted between stat and readFile — just write
        await writeActiveTaskFile(filePath, currentActive, currentCompleted);
        return true;
      }
      const merged = await merge(fresh);
      if (merged === null) return false; // Caller decided to abort
      [currentActive, currentCompleted] = merged;
      // Update knownMtime to fresh state for next iteration
      knownMtimeMutable = fresh.mtime;
      // Continue to next iteration to check for conflicts again
      continue;
    }

    // No conflict detected — write and return
    await writeActiveTaskFile(filePath, currentActive, currentCompleted);
    return true;
  }

  // Exhausted retries — write whatever we have (last-write-wins fallback)
  pluginLogger.warn(
    `memory-hybrid: writeActiveTaskFileOptimistic exhausted ${maxRetries} retries for ${filePath}; applying last-write-wins fallback`,
  );
  await writeActiveTaskFile(filePath, currentActive, currentCompleted);
  return true;
}

/**
 * Write ACTIVE-TASKS.md, but refuse to write if the session is a sub-agent.
 * Sub-agents should use `writeTaskSignal` to communicate status changes back
 * to the orchestrator instead of writing ACTIVE-TASKS.md directly.
 *
 * @param filePath   Absolute path to ACTIVE-TASKS.md
 * @param active     Active task entries to write
 * @param completed  Completed task entries to write
 * @param sessionKey The current session key (used to detect sub-agent mode)
 * @returns          Object indicating whether the write was skipped
 */
export async function writeActiveTaskFileGuarded(
  filePath: string,
  active: ActiveTaskEntry[],
  completed: ActiveTaskEntry[],
  sessionKey?: string,
): Promise<{ skipped: boolean; reason?: string }> {
  if (isSubagentSession(sessionKey)) {
    return {
      skipped: true,
      reason: "sub-agent sessions are read-only for ACTIVE-TASKS.md; use writeTaskSignal instead",
    };
  }
  await writeActiveTaskFile(filePath, active, completed);
  return { skipped: false };
}

/** Result of reconciling in-progress tasks whose backing session transcript is gone (#978, #981). */
export interface ActiveTaskSessionReconcileResult {
  reconciledLabels: string[];
  /** True when the file was written (skipped when dryRun or nothing to do). */
  wrote: boolean;
}

/**
 * For each "In progress" task with an OpenClaw-shaped session reference, if no session JSONL
 * exists under ~/.openclaw/agents (per-agent sessions folders), move the task to the Completed
 * section as Done with a note (unknown outcome / bookkeeping cleanup).
 */
export async function reconcileActiveTaskInProgressSessions(
  filePath: string,
  staleMinutes: number,
  opts: {
    openclawHome?: string;
    flushOnComplete?: boolean;
    memoryDir?: string;
    dryRun?: boolean;
  } = {},
): Promise<ActiveTaskSessionReconcileResult> {
  const taskFile = await readActiveTaskFile(filePath, staleMinutes);
  if (!taskFile) {
    return { reconciledLabels: [], wrote: false };
  }

  const openclawHome = opts.openclawHome;
  const newActive: ActiveTaskEntry[] = [];
  const newCompleted = [...taskFile.completed];
  const reconciledLabels: string[] = [];
  const toFlush: ActiveTaskEntry[] = [];

  for (const task of taskFile.active) {
    if (task.status !== "In progress") {
      newActive.push(task);
      continue;
    }
    const ref = task.subagent?.trim();
    if (!ref || !looksLikeOpenClawSessionRef(ref)) {
      newActive.push(task);
      continue;
    }
    const present = await isOpenClawSessionLikelyPresent(ref, openclawHome);
    if (present) {
      newActive.push(task);
      continue;
    }

    const now = new Date().toISOString();
    const completedEntry: ActiveTaskEntry = {
      ...task,
      status: "Done",
      updated: now,
      next: `Auto-reconciled: session transcript not found for ${ref} (subagent bookkeeping cleanup).`,
    };
    newCompleted.push(completedEntry);
    reconciledLabels.push(task.label);
    toFlush.push(completedEntry);
  }

  if (reconciledLabels.length === 0) {
    return { reconciledLabels, wrote: false };
  }
  if (opts.dryRun) {
    return { reconciledLabels, wrote: false };
  }

  await writeActiveTaskFile(filePath, newActive, newCompleted);

  if (opts.flushOnComplete && opts.memoryDir) {
    for (const entry of toFlush) {
      try {
        await flushCompletedTaskToMemory(entry, opts.memoryDir);
      } catch {
        // Non-fatal
      }
    }
  }

  return { reconciledLabels, wrote: true };
}

// ---------------------------------------------------------------------------
// Re-exports of types used in other modules
// ---------------------------------------------------------------------------
