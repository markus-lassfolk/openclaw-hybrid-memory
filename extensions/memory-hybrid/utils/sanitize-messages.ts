/**
 * Sanitize message arrays for Claude/Anthropic API.
 *
 * The API requires: each assistant message that contains `tool_use` blocks must be
 * immediately followed by a tool-role message with a `tool_result` block for every
 * tool_use id. When the conversation is trimmed (e.g. context window) or replayed
 * from logs, the follow-up tool_result messages can be dropped, causing:
 *
 *   "LLM request rejected: messages.N: `tool_use` ids were found without
 *    `tool_result` blocks immediately after: id1, id2. Each `tool_use` block
 *    must have a corresponding `tool_result` block in the next..."
 *
 * This utility fixes that by inserting synthetic tool_result messages for any
 * orphan tool_use ids so the request can be sent successfully.
 */

export type MessageLike = {
  role: string;
  content?: string | Array<{ type?: string; id?: string; tool_use_id?: string; content?: unknown; text?: string; name?: string; input?: unknown }>;
};

const PLACEHOLDER_CONTENT = "[Output omitted or truncated.]";

/**
 * Collect tool_use ids from an assistant message's content blocks.
 */
function getToolUseIds(content: MessageLike["content"]): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "tool_use") {
      const id = (block as { id?: string }).id;
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  }
  return ids;
}

/**
 * Collect tool_use_ids from a tool message's content blocks.
 */
function getToolResultIds(content: MessageLike["content"]): Set<string> {
  if (!Array.isArray(content)) return new Set();
  const set = new Set<string>();
  for (const block of content) {
    if (block && typeof block === "object" && ((block as { type?: string }).type === "tool_result" || (block as { type?: string }).type === "result")) {
      const tid = (block as { tool_use_id?: string }).tool_use_id;
      if (typeof tid === "string" && tid.trim()) set.add(tid.trim());
    }
  }
  return set;
}

/**
 * Ensure every assistant message that has tool_use blocks is immediately followed
 * by a tool message with a tool_result for each tool_use id. Inserts synthetic
 * tool messages with placeholder content for any missing tool_results.
 *
 * @param messages - Array of messages (role + content). Modified in place only by
 *   inserting new elements; existing objects are not mutated.
 * @returns New array with inserted tool messages where needed (or same array if
 *   no changes).
 */
export function sanitizeMessagesForClaude(messages: MessageLike[]): MessageLike[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const out: MessageLike[] = [];
  let changed = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as MessageLike).role;
    const content = (msg as MessageLike).content;

    out.push(msg);

    if (role !== "assistant") continue;

    const toolUseIds = getToolUseIds(content);
    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    const nextRole = next && typeof next === "object" ? (next as MessageLike).role : undefined;
    const nextContent = next && typeof next === "object" ? (next as MessageLike).content : undefined;
    const nextResultIds = nextRole === "tool" ? getToolResultIds(nextContent) : new Set<string>();

    const missing = toolUseIds.filter((id) => !nextResultIds.has(id));
    if (missing.length === 0) continue;

    const placeholderToolMessage: MessageLike = {
      role: "tool",
      content: missing.map((tool_use_id) => ({
        type: "tool_result",
        tool_use_id,
        content: PLACEHOLDER_CONTENT,
      })),
    };

    if (nextRole === "tool" && next && Array.isArray(nextContent)) {
      const existingBlocks = nextContent.slice() as Array<{ type?: string; tool_use_id?: string; content?: unknown }>;
      for (const id of missing) {
        existingBlocks.push({
          type: "tool_result",
          tool_use_id: id,
          content: PLACEHOLDER_CONTENT,
        });
      }
      out.push({
        ...next,
        content: existingBlocks,
      } as MessageLike);
      changed = true;
      i += 1;
      continue;
    }

    out.push(placeholderToolMessage);
    changed = true;
  }

  return changed ? out : messages;
}
