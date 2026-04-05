/**
 * Extract plain-text content of the last user message from a hook event payload.
 * Handles both string content and array-of-blocks content (e.g. `{type:"text", text:"…"}`).
 */

export function extractLastUserMessageText(event: unknown): string | undefined {
  const e = event as { messages?: unknown[] };
  if (!e?.messages || !Array.isArray(e.messages)) return undefined;
  for (let i = e.messages.length - 1; i >= 0; i--) {
    const m = e.messages[i] as { role?: string; content?: unknown };
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
