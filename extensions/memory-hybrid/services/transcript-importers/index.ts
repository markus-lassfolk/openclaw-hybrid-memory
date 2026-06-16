/**
 * Transcript importers for hybrid-mem mine (Issue #1915).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type TranscriptMessage = {
  role: string;
  content: string;
  timestamp?: string;
};

export type ParsedConversation = {
  id: string;
  title: string;
  messages: TranscriptMessage[];
  source: string;
  contentHash: string;
};

export function hashConversation(messages: TranscriptMessage[]): string {
  const payload = messages.map((m) => `${m.role}:${m.content}`).join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

/** Parse Claude Code JSONL (one JSON object per line with type/message). */
export function parseClaudeCodeJsonl(raw: string): ParsedConversation[] {
  const lines = raw.split("\n").filter((l) => l.trim());
  const messages: TranscriptMessage[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const msg = obj.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const role = String(msg.role ?? "unknown");
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? (msg.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
            : "";
      if (content) messages.push({ role, content });
    } catch {
      /* skip bad lines */
    }
  }
  if (messages.length === 0) return [];
  const hash = hashConversation(messages);
  return [
    {
      id: hash.slice(0, 12),
      title: "Claude Code session",
      messages,
      source: "claude-code",
      contentHash: hash,
    },
  ];
}

/** Parse plain text transcript (User:/Assistant: lines). */
export function parsePlainTextTranscript(raw: string): ParsedConversation[] {
  const messages: TranscriptMessage[] = [];
  const blocks = raw.split(/\n(?=(?:User|Assistant|Human|Claude)\s*:)/i);
  for (const block of blocks) {
    const match = block.match(/^(User|Assistant|Human|Claude)\s*:\s*([\s\S]*)/i);
    if (!match) continue;
    messages.push({ role: match[1].toLowerCase(), content: match[2].trim() });
  }
  if (messages.length === 0 && raw.trim()) {
    messages.push({ role: "user", content: raw.trim() });
  }
  const hash = hashConversation(messages);
  return messages.length
    ? [{ id: hash.slice(0, 12), title: "Text transcript", messages, source: "text", contentHash: hash }]
    : [];
}

export function detectAndParseTranscript(path: string, raw: string): ParsedConversation[] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jsonl")) {
    const claude = parseClaudeCodeJsonl(raw);
    if (claude.length > 0) return claude;
  }
  return parsePlainTextTranscript(raw);
}

export function readTranscriptFile(path: string): ParsedConversation[] {
  const raw = readFileSync(path, "utf8");
  return detectAndParseTranscript(path, raw);
}

/** Estimate LLM cost from byte count (nano tier rough heuristic). */
export function estimateMineCostUsd(byteCount: number, pricePerMToken = 0.15): number {
  const tokens = byteCount / 4;
  return (tokens / 1_000_000) * pricePerMToken;
}
