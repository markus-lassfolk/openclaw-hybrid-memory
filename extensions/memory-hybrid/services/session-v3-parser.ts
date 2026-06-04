/**
 * OpenClaw v3 session JSONL + trajectory (.trajectory.jsonl) parsing for maintenance backfill.
 *
 * v3 session messages use assistant `toolCall` blocks and separate `toolResult` rows.
 * Trajectory sidecars use `tool.call` / `tool.result` events with structured `data`.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { capturePluginError } from "./error-reporter.js";
import { extractRecalledMemoryIds, extractToolCallSequence, type SessionMessage } from "./session-signal-context.js";

export type ParsedRecallEvent = {
  query?: string;
  factIds: string[];
  hit: boolean;
};

export type TrajectoryToolEvent = {
  toolCallId: string;
  name: string;
  arguments?: Record<string, unknown>;
  resultPayload?: unknown;
};

function normalizeSessionRole(role: unknown): SessionMessage["role"] | null {
  if (role === "user" || role === "assistant" || role === "tool") return role;
  if (role === "toolResult") return "tool";
  return null;
}

/** Resolve companion trajectory path for a session JSONL file. */
export function companionTrajectoryPath(sessionFilePath: string): string {
  if (sessionFilePath.endsWith(".jsonl")) {
    return sessionFilePath.replace(/\.jsonl$/, ".trajectory.jsonl");
  }
  return `${sessionFilePath}.trajectory.jsonl`;
}

/** Extract fact UUIDs from v3 toolResult content and structured details.memories. */
export function extractFactIdsFromToolResultPayload(content: unknown, details?: unknown): string[] {
  const ids = new Set<string>(extractRecalledMemoryIds(Array.isArray(content) ? content : []));
  const scanText = (value: unknown): void => {
    if (typeof value !== "string") return;
    for (const match of value.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) {
      ids.add(match[0]);
    }
  };
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { text?: string; type?: string };
        scanText(b.text);
        if (b.type === "inputText") scanText(b.text);
      }
    }
  }
  if (details && typeof details === "object") {
    const memories = (details as { memories?: unknown }).memories;
    if (Array.isArray(memories)) {
      for (const row of memories) {
        if (row && typeof row === "object" && typeof (row as { id?: string }).id === "string") {
          ids.add((row as { id: string }).id);
        }
      }
    }
  }
  return [...ids];
}

function memoryRecallQueryFromArguments(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const query = (args as { query?: unknown }).query;
  return typeof query === "string" ? query : undefined;
}

function registerMemoryRecallPendingFromContent(
  content: unknown,
  pending: Map<string, { query?: string }>,
): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: string }).type;
    if (type !== "tool_use" && type !== "toolCall") continue;
    const name = (block as { name?: string }).name;
    if (name !== "memory_recall") continue;
    const toolId = (block as { id?: string }).id;
    if (!toolId) continue;
    const input = (block as { input?: Record<string, unknown> }).input;
    const args = (block as { arguments?: Record<string, unknown> }).arguments;
    pending.set(toolId, { query: memoryRecallQueryFromArguments(input ?? args) });
  }
}

/** Pair memory_recall tool calls with tool results across v3 session messages. */
export function extractRecallEventsFromMessages(messages: SessionMessage[]): ParsedRecallEvent[] {
  const events: ParsedRecallEvent[] = [];
  const pending = new Map<string, { query?: string }>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      registerMemoryRecallPendingFromContent(msg.content, pending);
      continue;
    }
    if (msg.role !== "tool") continue;
    const toolCallId = msg.toolCallId;
    const isRecall = msg.toolName === "memory_recall" || (toolCallId != null && pending.has(toolCallId));
    if (!isRecall) continue;

    const meta = toolCallId != null ? pending.get(toolCallId) : undefined;
    if (toolCallId != null) pending.delete(toolCallId);

    const factIds = extractFactIdsFromToolResultPayload(msg.content, msg.details);
    events.push({
      query: meta?.query,
      factIds,
      hit: factIds.length > 0,
    });
  }

  return events;
}

/** Ordered tool names from v3 session messages (assistant toolCall / legacy tool_use only). */
export function extractToolSequenceFromMessages(messages: SessionMessage[]): string[] {
  const tools: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      tools.push(...extractToolCallSequence(msg.content));
    }
  }
  return tools;
}

function parseTrajectoryLine(line: string, subsystem: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "parse-trajectory-line",
      severity: "info",
      subsystem,
    });
    return null;
  }
}

/** Parse trajectory tool.call / tool.result pairs (including memory_recall). */
export function extractRecallEventsFromTrajectoryLines(lines: string[], subsystem: string): ParsedRecallEvent[] {
  const pending = new Map<string, { query?: string }>();
  const events: ParsedRecallEvent[] = [];

  for (const line of lines) {
    const obj = parseTrajectoryLine(line, subsystem);
    if (!obj) continue;
    const type = obj.type;
    const data = obj.data;
    if (!data || typeof data !== "object") continue;
    const d = data as Record<string, unknown>;
    const toolCallId = typeof d.toolCallId === "string" ? d.toolCallId : undefined;
    const name = typeof d.name === "string" ? d.name : undefined;

    if (type === "tool.call" && toolCallId && name === "memory_recall") {
      pending.set(toolCallId, { query: memoryRecallQueryFromArguments(d.arguments) });
      continue;
    }

    if (type === "tool.result" && toolCallId && pending.has(toolCallId)) {
      const meta = pending.get(toolCallId)!;
      pending.delete(toolCallId);
      const contentItems = d.contentItems;
      const payload = contentItems ?? d.content ?? d;
      const factIds = extractFactIdsFromToolResultPayload(payload, d.details ?? d);
      events.push({
        query: meta.query,
        factIds,
        hit: factIds.length > 0,
      });
    }
  }

  return events;
}

/** Ordered tool names from trajectory tool.call events. */
export function extractToolSequenceFromTrajectoryLines(lines: string[], subsystem: string): string[] {
  const tools: string[] = [];
  for (const line of lines) {
    const obj = parseTrajectoryLine(line, subsystem);
    if (!obj || obj.type !== "tool.call") continue;
    const data = obj.data;
    if (!data || typeof data !== "object") continue;
    const name = (data as { name?: string }).name;
    if (typeof name === "string" && name.trim()) tools.push(name.trim());
  }
  return tools;
}

export function readTrajectoryLines(sessionFilePath: string): string[] | null {
  const trajPath = companionTrajectoryPath(sessionFilePath);
  if (!existsSync(trajPath)) return null;
  try {
    return readFileSync(trajPath, "utf-8").split("\n");
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "read-trajectory-file",
      severity: "info",
      subsystem: "session-v3-parser",
      context: basename(trajPath),
    });
    return null;
  }
}

export { normalizeSessionRole };
