/**
 * Unified recalled-context assembly: edicts, untrusted-data boundary, and prepend wrapping.
 * Used by recall, injection, post-compaction, and ambient-only paths (Issue #1579).
 */

import { capturePluginError } from "./error-reporter.js";
import { trimBlockToBudget } from "./context-block-trim.js";
import { RECALLED_CONTEXT_BOUNDARY, sanitizePromptInjection } from "./skill-prompt-injection.js";
import {
  buildVaultContextBlock,
  buildVaultFactsBlock,
  entriesToVaultFactLines,
  type VaultFactLine,
} from "./vault-context.js";
import { filterFactTextsForInjection, type InjectionFilterMode } from "./injection-filter.js";
import { resolveVaultFactsTriples } from "./vault-facts-resolver.js";
import { extractLastUserMessageText } from "../utils/extract-last-user-message.js";
import type { LifecycleContext } from "../lifecycle/types.js";
import type { SearchResult } from "../types/memory.js";
import { estimateTokens, truncateForStorage } from "../utils/text.js";

/** Max share of the interactive prepend budget reserved for edicts (remainder goes to memories). */
export const DEFAULT_EDICT_BUDGET_FRACTION = 0.2;

/** Edict token cap from a prepend or recall budget total. */
export function edictMaxTokensForBudget(
  totalBudgetTokens: number,
  fraction: number = DEFAULT_EDICT_BUDGET_FRACTION,
): number {
  if (totalBudgetTokens <= 0) return 0;
  return Math.max(0, Math.floor(totalBudgetTokens * fraction));
}

/** Edict cap from the active per-turn prepend budget ref, when initialized. */
export function edictMaxTokensFromPrependBudget(ctx: LifecycleContext): number | undefined {
  const total = ctx.prependBudgetRef?.value?.totalTokens;
  if (total == null || total <= 0) return undefined;
  return edictMaxTokensForBudget(total);
}

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

/** Wrap untrusted stored/user content for auxiliary injection paths (auth hints, pinned facts). */
export function wrapUntrustedMemoryContent(memoryContent: string): string {
  const trimmed = memoryContent.trim();
  if (!trimmed) return "";
  return wrapRecalledContext("", trimmed);
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

/** Structured vault-context wrapper for explicit opt-in injection paths (#1912). */
export function wrapRecalledContextStructured(
  edicts: string,
  facts: VaultFactLine[],
  options?: { legacyMemoryContextWrapper?: boolean },
): string {
  const vaultBlock = buildVaultContextBlock({ facts, legacyMemoryContextWrapper: options?.legacyMemoryContextWrapper });
  return wrapRecalledContext(edicts, vaultBlock);
}

/** Apply structured vault-context wrapper and optional vault-facts SPO block (#1912). */
export function finalizeInjectionMemoryContent(
  ctx: LifecycleContext,
  event: unknown,
  plainMemoryContent: string,
  candidates: SearchResult[],
): string {
  const boundary = ctx.cfg.retrieval?.contextBoundary;
  const prompt = extractLastUserMessageText(event) ?? "";
  const vaultBudget = boundary?.vaultFactsMaxTokens?.balanced ?? 200;
  let spoBlock = "";
  if (vaultBudget > 0 && prompt.trim()) {
    const triples = resolveVaultFactsTriples(ctx.factsDb, prompt);
    spoBlock = buildVaultFactsBlock(triples, vaultBudget, estimateTokens);
  }

  const useStructured = boundary?.legacyMemoryContextWrapper === false;
  if (!useStructured) {
    return spoBlock ? `${spoBlock}\n\n${plainMemoryContent}` : plainMemoryContent;
  }

  const injectionFilterMode: InjectionFilterMode = boundary?.injectionFilter ?? "audit";
  const rawFacts: VaultFactLine[] = entriesToVaultFactLines(candidates.map((c) => c.entry));
  const facts: VaultFactLine[] = rawFacts
    .map((fact) => {
      const { allowed } = filterFactTextsForInjection([fact.text], injectionFilterMode);
      return allowed.length > 0 ? { ...fact, text: allowed[0] } : null;
    })
    .filter((f): f is VaultFactLine => f !== null);
  if (plainMemoryContent.trim() && facts.length === 0) {
    facts.push({ text: plainMemoryContent, contentType: "recall" });
  }
  const vaultBlock = buildVaultContextBlock({
    facts,
    legacyMemoryContextWrapper: boundary?.legacyMemoryContextWrapper !== false,
  });
  const parts = [spoBlock, vaultBlock, plainMemoryContent].filter(Boolean);
  return parts.join("\n\n");
}

/** Filter fact lines through 5-layer injection filter before injection. */
export function filterMemoryLinesForInjection(
  lines: string[],
  mode: InjectionFilterMode,
): { lines: string[]; filtered: number } {
  const { allowed, stats } = filterFactTextsForInjection(lines, mode);
  return { lines: allowed, filtered: stats.filtered };
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
  if (cap != null) {
    if (cap <= 0) return "";
    return trimBlockToBudget(raw, cap).text;
  }
  return raw;
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

/** Sanitize optional memory metadata for injection or tool output. */
export function sanitizeMemoryField(text: string | null | undefined): string {
  if (text == null) return "";
  const trimmed = String(text).trim();
  if (!trimmed) return "";
  return sanitizePromptInjection(trimmed);
}

const INJECTION_REDACTION = "[redacted: prompt-injection marker]";

/** True when sanitized text still has non-redaction content worth storing. */
export function isSubstantiveMemoryText(text: string): boolean {
  const stripped = text.replace(new RegExp(INJECTION_REDACTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "").trim();
  return stripped.length > 0;
}

/** Sanitize and truncate fact text before SQLite/Lance persistence (Issue #1579 store-time defense). */
export function prepareMemoryTextForStorage(text: string, maxChars: number): string {
  const sanitized = sanitizeMemoryField(text);
  return truncateForStorage(sanitized, maxChars);
}

/** Sanitize optional metadata fields (entity, key, why, tags) before persistence. */
export function prepareMemoryMetadataForStorage(text: string | null | undefined): string | undefined {
  const sanitized = sanitizeMemoryField(text);
  return sanitized || undefined;
}

/** Format one memory line for memory_recall tool results (sanitized). */
export function formatMemoryRecallToolLine(
  entry: { text: string; category: string; why?: string | null },
  opts?: {
    backend?: string;
    linePrefix?: string;
    scorePct?: string;
    extraSuffix?: string;
  },
): string {
  const category = sanitizeMemoryField(entry.category) || "fact";
  const text = sanitizeMemoryField(entry.text);
  const backend = sanitizeMemoryField(opts?.backend) || "sqlite";
  const prefix = opts?.linePrefix ?? "";
  const score = opts?.scorePct ? ` (${opts.scorePct})` : "";
  const suffix = opts?.extraSuffix ?? "";
  const why = entry.why ? `\n   Why: ${sanitizeMemoryField(entry.why)}` : "";
  return `${prefix}[${backend}/${category}] ${text}${score}${suffix}${why}`;
}

/** Prefix for memory_recall tool text payloads (untrusted recalled data). */
export function memoryRecallToolBoundaryPrefix(): string {
  return `${RECALLED_CONTEXT_BOUNDARY}\n`;
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
  if (opts?.entity) {
    const entity = sanitizePromptInjection(opts.entity);
    return entity ? `- [${entity}] ${preview}` : `- ${preview}`;
  }
  if (opts?.category) {
    const category = sanitizePromptInjection(opts.category);
    return category ? `- [${category}] ${preview}` : `- ${preview}`;
  }
  return `- ${preview}`;
}
