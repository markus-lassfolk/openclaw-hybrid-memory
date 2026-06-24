/**
 * Per-turn recall attribution (Issue #1916).
 */

export type ConversationTurn = {
  index: number;
  role: "user" | "assistant" | "tool" | "other";
  text: string;
};

export type TurnAttribution = {
  turnIndex: number;
  injectedFactIds: string[];
  referencedFactIds: string[];
};

/** Segment messages into turns for attribution. Falls back to single turn on uncertainty. */
export function segmentTranscriptIntoTurns(messages: Array<{ role?: string; content?: unknown }>): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let idx = 0;
  for (const msg of messages) {
    const roleRaw = String(msg.role ?? "other").toLowerCase();
    const role: ConversationTurn["role"] =
      roleRaw === "user" || roleRaw === "human"
        ? "user"
        : roleRaw === "assistant"
          ? "assistant"
          : roleRaw === "tool"
            ? "tool"
            : "other";
    const text =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
          : "";
    if (!text.trim()) continue;
    turns.push({ index: idx++, role, text: text.trim() });
  }
  if (turns.length === 0) return [{ index: 0, role: "user", text: "" }];
  return turns;
}

/** Attribute injected fact ids to the user turn that triggered injection (pre-response). */
export function attributeInjectionToTurn(turns: ConversationTurn[], injectedFactIds: string[]): TurnAttribution {
  if (injectedFactIds.length === 0) {
    return { turnIndex: 0, injectedFactIds: [], referencedFactIds: [] };
  }
  let lastUser = -1;
  for (const t of turns) {
    if (t.role === "user") lastUser = t.index;
  }
  const targetTurn = lastUser >= 0 ? lastUser : (turns[turns.length - 1]?.index ?? 0);
  return { turnIndex: targetTurn, injectedFactIds, referencedFactIds: [] };
}

/** Detect fact id references in assistant text (simple substring on short ids). */
export function detectReferencedFactIds(assistantText: string, candidateIds: string[]): string[] {
  const lower = assistantText.toLowerCase();
  return candidateIds.filter((id) => lower.includes(id.toLowerCase().slice(0, 8)));
}
