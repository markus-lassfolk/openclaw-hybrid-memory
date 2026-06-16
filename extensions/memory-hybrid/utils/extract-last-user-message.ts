/**
 * Extract plain-text user turn text from a before_agent_start hook event.
 *
 * OpenClaw delivers the current turn via `event.prompt` (agent heartbeat, cron
 * agentTurn, interactive chat). Some callers also populate `event.messages`;
 * prompt takes precedence when both are present (#1895).
 *
 * Handles string content and array-of-blocks content in messages
 * (e.g. `{type:"text", text:"…"}`).
 */

function extractFromMessages(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const parts: string[] = [];
      for (const block of c) {
        const b = block as { type?: string; text?: string };
        if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
      if (parts.length > 0) return parts.join("\n");
    }
  }
  return undefined;
}

export function extractLastUserMessageText(event: unknown): string | undefined {
  const e = event as { prompt?: string; messages?: unknown[] };
  if (typeof e?.prompt === "string") {
    const trimmed = e.prompt.trim();
    if (trimmed.length > 0) return e.prompt;
  }
  if (e?.messages && Array.isArray(e.messages)) {
    return extractFromMessages(e.messages);
  }
  return undefined;
}
