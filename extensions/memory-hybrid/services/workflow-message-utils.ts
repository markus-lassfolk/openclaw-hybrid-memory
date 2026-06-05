/**
 * Shared helpers for workflow trace capture from agent message logs.
 */

/** Messages from the last user turn onward (agent_end receives full session history). */
export function currentTurnSlice(messages: unknown[]): unknown[] {
  let lastUserIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if ((msg as { role?: unknown }).role === "user") lastUserIndex = i;
  }
  if (lastUserIndex < 0) return messages;
  return messages.slice(lastUserIndex);
}

/** Extract ordered tool names from assistant messages (OpenAI tool_calls + v3 tool_use blocks). */
export function extractToolNamesFromMessages(messages: unknown[]): string[] {
  const names: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant") continue;

    const toolCalls = m.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        const fn = (tc as { function?: unknown }).function;
        if (!fn || typeof fn !== "object") continue;
        const name = (fn as { name?: unknown }).name;
        if (typeof name === "string" && name.trim()) names.push(name.trim());
      }
    }

    const content = m.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        const blockType = typeof b.type === "string" ? b.type : "";
        if (blockType !== "tool_use" && blockType !== "toolCall") continue;
        const name = typeof b.name === "string" ? b.name : typeof b.toolName === "string" ? b.toolName : null;
        if (typeof name === "string" && name.trim()) names.push(name.trim());
      }
    }

    const legacyToolCalls = m.toolCalls;
    if (Array.isArray(legacyToolCalls)) {
      for (const name of legacyToolCalls) {
        if (typeof name === "string" && name.trim()) names.push(name.trim());
      }
    }
  }

  return names;
}

const FAILURE_HINT = /\b(error|failed|failure|iserror|timed out)\b/i;
const SUCCESS_HINT = /\b(done|success(?:fully)?|completed|fixed|merged)\b/i;

/** Best-effort outcome for a completed session transcript (backfill / offline QA). */
export function inferWorkflowOutcomeFromMessages(messages: unknown[]): "success" | "failure" | "unknown" {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role === "tool" || m.role === "toolResult") {
      if (m.isError === true) return "failure";
      const content = m.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && (block as { isError?: boolean }).isError === true) {
            return "failure";
          }
        }
      }
    }
    if (m.role === "assistant" || m.role === "user") {
      const texts: string[] = [];
      if (typeof m.text === "string") texts.push(m.text);
      if (typeof m.content === "string") texts.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          const b = block as { type?: string; text?: string };
          if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
        }
      }
      const joined = texts.join(" ").toLowerCase();
      if (FAILURE_HINT.test(joined)) return "failure";
      if (SUCCESS_HINT.test(joined)) return "success";
    }
  }
  return "unknown";
}
