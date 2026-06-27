/**
 * Live directive/correction nudge — prompts agent to memory_store important user instructions.
 */

import type { UserStoreDirective } from "./directive-extract.js";
import { sanitizeMemoryField } from "./recalled-context-assembler.js";

/** Format a prepend block urging immediate memory_store for a detected directive. */
export function formatDirectiveStoreNudgeBlock(directive: UserStoreDirective): string {
  const categories = directive.categories.join(", ");
  const safeText = sanitizeMemoryField(directive.storeText);
  return [
    "<memory-store-nudge>",
    "The user's latest message contains a correction or instruction that should be persisted now.",
    `Detected categories: ${categories}.`,
    "Action required this turn:",
    `  memory_store(text=${JSON.stringify(safeText)}, category="${directive.memoryCategory}", importance=${directive.importance})`,
    "If memory_store returns duplicate or noop, do NOT retry — the fact is already recorded.",
    "Use memory_forget only when replacing an incorrect older fact.",
    "</memory-store-nudge>",
  ].join("\n");
}
