/**
 * Normalize assistant chat completion messages to parseable text.
 * Handles string content, array content blocks, native tool_calls, and reasoning fallbacks.
 */

export type AssistantMessageTextSource = "content" | "content_blocks" | "tool_calls" | "reasoning" | "empty";

export type AssistantMessageTextResult = {
  text: string;
  source: AssistantMessageTextSource;
};

function stripLeadingReasoningBlocks(value: string): string {
  let text = value.trim();
  for (;;) {
    const next = text
      .replace(/^(?:<think>|<thinking>|<reasoning>|<analysis>)\s*[\s\S]*?\s*<\/(?:think|thinking|reasoning|analysis)>\s*/i, "")
      .replace(/^```(?:think|thinking|reasoning|analysis)\s*[\s\S]*?```\s*/i, "")
      .trim();
    if (next === text) return text;
    text = next;
  }
}

function trimNonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = stripLeadingReasoningBlocks(value);
  return trimmed.length > 0 ? trimmed : null;
}

function contentBlocksToString(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as Record<string, unknown>;
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" && typeof block.text === "string" && block.text.trim()) {
      const text = trimNonEmpty(block.text);
      if (text) parts.push(text);
      continue;
    }
    if (typeof block.text === "string" && block.text.trim()) {
      const text = trimNonEmpty(block.text);
      if (text) parts.push(text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : null;
}

function toolCallsToString(toolCalls: unknown): string | null {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  const argumentStrings: string[] = [];
  for (const call of toolCalls) {
    if (!call || typeof call !== "object") continue;
    const record = call as Record<string, unknown>;
    const fn = record.function;
    if (fn && typeof fn === "object") {
      const args = (fn as Record<string, unknown>).arguments;
      const trimmed = trimNonEmpty(args);
      if (trimmed) argumentStrings.push(trimmed);
      continue;
    }
    const directArgs = record.arguments ?? record.input;
    const trimmed = trimNonEmpty(directArgs);
    if (trimmed) argumentStrings.push(trimmed);
  }
  if (argumentStrings.length === 0) return null;
  if (argumentStrings.length === 1) return argumentStrings[0]!;
  return JSON.stringify({ tool_calls: argumentStrings });
}

function isPlaceholderContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed === "[]" || trimmed === "{}") return true;
  return false;
}

/**
 * Extract assistant text from a chat completion message for downstream JSON/structured parsing.
 * Priority: string content → array text blocks → tool_calls arguments → reasoning fields.
 */
export function extractAssistantMessageText(message: unknown): AssistantMessageTextResult {
  if (!message || typeof message !== "object") {
    return { text: "", source: "empty" };
  }
  const msg = message as Record<string, unknown>;

  const stringContent = trimNonEmpty(msg.content);
  if (stringContent && !isPlaceholderContent(stringContent)) {
    return { text: stringContent, source: "content" };
  }

  const blockContent = contentBlocksToString(msg.content);
  if (blockContent) return { text: blockContent, source: "content_blocks" };

  const toolCallsText = toolCallsToString(msg.tool_calls ?? msg.toolCalls);
  if (toolCallsText) return { text: toolCallsText, source: "tool_calls" };

  const reasoningContent = trimNonEmpty(msg.reasoning_content);
  if (reasoningContent) return { text: reasoningContent, source: "reasoning" };

  const reasoning = trimNonEmpty(msg.reasoning);
  if (reasoning) return { text: reasoning, source: "reasoning" };

  return { text: "", source: "empty" };
}
