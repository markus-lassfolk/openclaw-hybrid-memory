import { readFileSync } from "node:fs";

/**
 * Extract text content from session JSONL file.
 */
export function extractTextFromSessionJsonl(filePath: string): string {
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const parts: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      if (!obj || typeof obj !== "object") continue;
      if (obj.type !== "message" || !obj.message) continue;
      const msg = obj.message;
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
          parts.push(block.text.trim());
        }
      }
    } catch {
      // NOTE: Intentionally NOT using capturePluginError here to avoid flooding
      // error logs with JSON parse errors from malformed session lines.
      // This is a best-effort parser; we skip bad lines silently.
    }
  }
  return parts.join("\n\n");
}
