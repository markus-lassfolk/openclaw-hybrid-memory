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

/** Hash the exact persisted transcript body (after redaction / formatting). */
export function hashStoredTranscriptText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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

/** Parse ChatGPT export JSON (conversations.json or single conversation). */
export function parseChatGptExport(raw: string): ParsedConversation[] {
  try {
    const data = JSON.parse(raw) as unknown;
    const items = Array.isArray(data) ? data : [data];
    const out: ParsedConversation[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const conv = item as Record<string, unknown>;
      const title = String(conv.title ?? "ChatGPT conversation");
      const mapping = conv.mapping as
        | Record<string, { message?: { author?: { role?: string }; content?: { parts?: string[] } } }>
        | undefined;
      const messages: TranscriptMessage[] = [];
      if (mapping) {
        for (const node of Object.values(mapping)) {
          const msg = node?.message;
          const role = String(msg?.author?.role ?? "user");
          const parts = msg?.content?.parts;
          const content = Array.isArray(parts) ? parts.map(String).join("\n") : "";
          if (content.trim()) messages.push({ role, content: content.trim() });
        }
      }
      if (messages.length === 0) continue;
      const hash = hashConversation(messages);
      out.push({ id: hash.slice(0, 12), title, messages, source: "chatgpt", contentHash: hash });
    }
    return out;
  } catch {
    return [];
  }
}

/** Parse Claude.ai export JSON. */
export function parseClaudeAiExport(raw: string): ParsedConversation[] {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const messages: TranscriptMessage[] = [];
    const chat = (data.chat_messages ?? data.messages) as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(chat)) {
      for (const m of chat) {
        const role = String(m.sender ?? m.role ?? "user");
        const content = typeof m.text === "string" ? m.text : typeof m.content === "string" ? m.content : "";
        if (content.trim()) messages.push({ role, content: content.trim() });
      }
    }
    if (messages.length === 0) return [];
    const hash = hashConversation(messages);
    const title = String(data.name ?? data.title ?? "Claude.ai conversation");
    return [{ id: hash.slice(0, 12), title, messages, source: "claude-ai", contentHash: hash }];
  } catch {
    return [];
  }
}

/** Parse Slack export JSON (single channel day file). */
export function parseSlackExport(raw: string): ParsedConversation[] {
  try {
    const data = JSON.parse(raw) as unknown;
    const items = Array.isArray(data) ? data : [data];
    const messages: TranscriptMessage[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const text = typeof row.text === "string" ? row.text : "";
      const user = String(row.user ?? row.user_profile ?? "user");
      if (text.trim()) messages.push({ role: user, content: text.trim() });
    }
    if (messages.length === 0) return [];
    const hash = hashConversation(messages);
    return [{ id: hash.slice(0, 12), title: "Slack export", messages, source: "slack", contentHash: hash }];
  } catch {
    return [];
  }
}

// Kept in sync with services/error-reporter/sanitize.ts's scrubString pattern set (#2067-followup
// sweep): the original list here only matched plain "sk-<alnum>" keys, missing the sk-ant-/sk-proj-
// prefixed formats and any keyword-based (password=/secret=/token=) or private-key-block secrets —
// this is the only redaction pass applied before raw transcript content is stored as facts.text.
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "openai_key", regex: /\bsk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_]{20,})\b/g },
  { name: "github_token", regex: /\bgh[po]_[A-Za-z0-9]{20,}\b/g },
  { name: "aws_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "bearer", regex: /\bBearer\s+[A-Za-z0-9_.~+/=-]{12,}\b/gi },
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: "private_key_block", regex: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g },
  {
    name: "keyword_secret",
    regex: /\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
  },
];

/** Redact common secret patterns before mine ingest. */
export function redactSecretsInText(text: string): {
  text: string;
  redacted: number;
  categories: Record<string, number>;
} {
  let out = text;
  let redacted = 0;
  const categories: Record<string, number> = {};
  for (const { name, regex } of SECRET_PATTERNS) {
    const matches = out.match(regex);
    if (matches?.length) {
      categories[name] = (categories[name] ?? 0) + matches.length;
      redacted += matches.length;
      out = out.replace(regex, `[REDACTED:${name}]`);
    }
  }
  return { text: out, redacted, categories };
}

export function detectAndParseTranscript(path: string, raw: string, sourceHint?: string): ParsedConversation[] {
  const lower = path.toLowerCase();
  const hint = sourceHint?.toLowerCase();

  if (hint === "chatgpt" || lower.includes("chatgpt") || lower.includes("conversations.json")) {
    const parsed = parseChatGptExport(raw);
    if (parsed.length > 0) return parsed;
  }
  if (hint === "claude-ai" || lower.includes("claude.ai")) {
    const parsed = parseClaudeAiExport(raw);
    if (parsed.length > 0) return parsed;
  }
  if (hint === "slack" || lower.includes("slack")) {
    const parsed = parseSlackExport(raw);
    if (parsed.length > 0) return parsed;
  }
  if (lower.endsWith(".json")) {
    const chatgpt = parseChatGptExport(raw);
    if (chatgpt.length > 0) return chatgpt;
    const claudeAi = parseClaudeAiExport(raw);
    if (claudeAi.length > 0) return claudeAi;
    const slack = parseSlackExport(raw);
    if (slack.length > 0) return slack;
  }
  if (lower.endsWith(".jsonl") || hint === "claude-code") {
    const claude = parseClaudeCodeJsonl(raw);
    if (claude.length > 0) return claude;
  }
  return parsePlainTextTranscript(raw);
}

export function readTranscriptFile(path: string, sourceHint?: string): ParsedConversation[] {
  const raw = readFileSync(path, "utf8");
  return detectAndParseTranscript(path, raw, sourceHint);
}

/** Estimate LLM cost from byte count (nano tier rough heuristic). */
export function estimateMineCostUsd(byteCount: number, pricePerMToken = 0.15): number {
  const tokens = byteCount / 4;
  return (tokens / 1_000_000) * pricePerMToken;
}
