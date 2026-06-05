/**
 * Unified recalled-context assembly: edicts, untrusted-data boundary, and prepend wrapping.
 * Used by recall, injection, post-compaction, and ambient-only paths (Issue #1579).
 */

import { capturePluginError } from "./error-reporter.js";
import { trimBlockToBudget } from "./context-block-trim.js";
import { RECALLED_CONTEXT_BOUNDARY, sanitizePromptInjection } from "./skill-prompt-injection.js";
import type { LifecycleContext } from "../lifecycle/types.js";

/** Max share of the interactive prepend budget reserved for edicts (remainder goes to memories). */
export const DEFAULT_EDICT_BUDGET_FRACTION = 0.2;

/** Get the edict block for forced prompt injection. */
export function buildEdictBlock(ctx: LifecycleContext): string {
  try {
    const { renderForPrompt } = ctx.edictStore.getEdicts({ format: "prompt" });
    return renderForPrompt;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (!/database connection is not open/i.test(e.message)) {
      capturePluginError(e, {
        subsystem: "recalled-context-assembler",
        operation: "get-edicts",
      });
    }
    return "";
  }
}

/** Wrap memory content with optional edicts and the untrusted-data boundary. */
export function wrapRecalledContext(edicts: string, memoryContent: string): string {
  if (!edicts && !memoryContent) return "";
  const parts: string[] = ["<recalled-context>"];
  if (edicts) parts.push(edicts);
  if (memoryContent) {
    parts.push(RECALLED_CONTEXT_BOUNDARY);
    parts.push(memoryContent);
  }
  parts.push("</recalled-context>");
  return parts.join("\n");
}

export type AssembleRecallPrependOptions = {
  /** HTML comment prepended before the recalled-context block (e.g. degraded marker). */
  prefix?: string;
  /** Append latency degradation marker inside memory content. */
  markLatencyDegraded?: boolean;
  recallStartMs?: number;
  degradationMaxLatencyMs?: number;
  /** Pre-trimmed edict block; when omitted, loaded from store and capped by `edictMaxTokens`. */
  edictBlock?: string;
  /** Cap edicts to this many tokens (default: no cap when unset). */
  edictMaxTokens?: number;
};

function resolveEdictBlock(ctx: LifecycleContext, options?: AssembleRecallPrependOptions): string {
  if (options?.edictBlock !== undefined) return options.edictBlock;
  const raw = buildEdictBlock(ctx);
  if (!raw) return "";
  const cap = options?.edictMaxTokens;
  if (cap == null || cap <= 0) return raw;
  return trimBlockToBudget(raw, cap).text;
}

/** Build a full prepend block from ambient/memory content with edicts and boundary. */
export function assembleRecallPrependContext(
  ctx: LifecycleContext,
  memoryContent: string,
  options?: AssembleRecallPrependOptions,
): string | undefined {
  const edicts = resolveEdictBlock(ctx, options);
  const trimmed = memoryContent.trim();
  if (!trimmed && !edicts) return undefined;

  let content = trimmed;
  if (
    options?.markLatencyDegraded &&
    options.degradationMaxLatencyMs != null &&
    options.degradationMaxLatencyMs > 0 &&
    options.recallStartMs != null &&
    Date.now() - options.recallStartMs > options.degradationMaxLatencyMs
  ) {
    content = `<!-- recall degraded: latency -->\n${content}`;
  }

  const wrapped = wrapRecalledContext(edicts, content);
  if (!wrapped) return undefined;
  const prefix = options?.prefix?.trim();
  return prefix ? `${prefix}\n${wrapped}\n\n` : `${wrapped}\n\n`;
}

/** Sanitize procedure task patterns before injection. */
export function sanitizeProcedureText(text: string): string {
  return sanitizePromptInjection(text);
}

/**
 * Entity mention check with token boundaries to avoid substring false positives
 * (e.g. prompt "userland" matching entity "user").
 */
export function promptMentionsEntity(prompt: string, entity: string): boolean {
  const ent = entity.trim().toLowerCase();
  if (!ent) return false;
  const lower = prompt.toLowerCase();
  const escaped = ent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[^a-z0-9_-])${escaped}(?:[^a-z0-9_-]|$)`, "i");
  return re.test(lower);
}

/** Sanitize a single line of post-compaction or summary memory preview. */
export function formatSanitizedMemoryPreview(
  text: string,
  opts?: { entity?: string | null; category?: string; maxChars?: number },
): string {
  const sanitized = sanitizePromptInjection(text.replace(/\s+/g, " ").trim());
  if (!sanitized) return "";
  const max = opts?.maxChars ?? 200;
  const preview = sanitized.length > max ? `${sanitized.slice(0, max)}…` : sanitized;
  if (opts?.entity) return `- [${opts.entity}] ${preview}`;
  if (opts?.category) return `- [${opts.category}] ${preview}`;
  return `- ${preview}`;
}
