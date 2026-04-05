/**
 * Extract plain-text content of the last user message from a hook event payload.
 */

export function extractLastUserMessageText(event: unknown): string | undefined {
  const e = event as { messages?: unknown[] };
  if (!e?.messages || !Array.isArray(e.messages)) return undefined;
  for (let i = e.messages.length - 1; i >= 0; i--) {
    const m = e.messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
  }
  return undefined;
}
