/**
 * Synthesize sparse daily memory logs from session JSONL (runtime hook + backfill).
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getEnv } from "../utils/env-manager.js";
import { extractToolCallSequence, parseSessionMessagesFromLines } from "./session-signal-context.js";
import { redactMaintenancePrivateText } from "../utils/maintenance-privacy.js";

const MARKER_PREFIX = "<!-- hybrid-mem-session:";

export function resolveDailyMemoryDir(): string {
  const workspace = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
  const workspaceMemory = join(workspace, "memory");
  if (existsSync(workspaceMemory)) return workspaceMemory;
  return join(homedir(), ".openclaw", "memory");
}

function sessionMarker(sessionKey: string): string {
  const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 16);
  return `${MARKER_PREFIX}${hash} -->`;
}

export type DailySessionSummaryInput = {
  sessionKey: string;
  agentId?: string;
  turnCount: number;
  toolsUsed: string[];
  outcome?: "success" | "failure" | "unknown";
  topicLine?: string;
  date?: string;
};

export function formatDailySessionSummary(input: DailySessionSummaryInput): string {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const agent = input.agentId ?? "unknown";
  const tools =
    input.toolsUsed.length > 0
      ? input.toolsUsed.slice(0, 8).join(", ")
      : "(none)";
  const outcome = input.outcome ?? "unknown";
  const topic = input.topicLine ? redactMaintenancePrivateText(input.topicLine).slice(0, 120) : "session activity";
  return [
    sessionMarker(input.sessionKey),
    `- **${date}** agent=\`${agent}\` turns=${input.turnCount} outcome=${outcome} tools=${tools}`,
    `  - ${topic}`,
  ].join("\n");
}

export function appendDailySessionSummary(input: DailySessionSummaryInput): string {
  const memoryDir = resolveDailyMemoryDir();
  mkdirSync(memoryDir, { recursive: true });
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const filePath = join(memoryDir, `${date}.md`);
  const marker = sessionMarker(input.sessionKey);
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    if (existing.includes(marker)) return filePath;
  }
  const block = `\n${formatDailySessionSummary({ ...input, date })}\n`;
  if (existsSync(filePath)) {
    appendFileSync(filePath, block, "utf-8");
  } else {
    writeFileSync(filePath, `# Daily log ${date}\n${block}`, "utf-8");
  }
  return filePath;
}

function inferTopicFromMessages(messages: Array<{ role: string; text: string }>): string {
  for (const msg of messages) {
    if (msg.role === "user" && msg.text.trim().length >= 12) {
      return msg.text.trim().slice(0, 120);
    }
  }
  return "session activity";
}

function inferOutcome(messages: Array<{ role: string; text: string }>): "success" | "failure" | "unknown" {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i].text.toLowerCase();
    if (/\b(error|failed|failure)\b/.test(t)) return "failure";
    if (/\b(done|success|completed|fixed)\b/.test(t)) return "success";
  }
  return "unknown";
}

export function synthesizeDailyLogFromSessionFile(filePath: string, agentId?: string): string | null {
  const sessionKey = basename(filePath);
  let date = new Date().toISOString().slice(0, 10);
  try {
    date = new Date(statSync(filePath).mtimeMs).toISOString().slice(0, 10);
  } catch {
    // keep today
  }
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const messages = parseSessionMessagesFromLines(lines, "backfill-daily-logs");
  if (messages.length === 0) return null;
  const tools = new Set<string>();
  for (const msg of messages) {
    for (const tool of extractToolCallSequence(msg.content)) tools.add(tool);
  }
  return appendDailySessionSummary({
    sessionKey,
    agentId,
    turnCount: messages.length,
    toolsUsed: [...tools],
    outcome: inferOutcome(messages),
    topicLine: inferTopicFromMessages(messages),
    date,
  });
}

export function countDailyLogFiles(memoryDir: string, sinceDate?: string): number {
  if (!existsSync(memoryDir)) return 0;
  return readdirSync(memoryDir).filter((f) => {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) return false;
    return sinceDate ? f.slice(0, 10) >= sinceDate : true;
  }).length;
}
