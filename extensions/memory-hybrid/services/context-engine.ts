/**
 * ContextEngine Plugin Slot Adoption (Issue #273)
 *
 * Registers the hybrid-memory plugin as an OpenClaw ContextEngine when the
 * registerContextEngine API is available (OpenClaw ≥ 2026.3.8).
 *
 * Capabilities:
 *  - compact: flush WAL + snapshot session-scoped facts before compaction
 *  - prepareSubagentSpawn: inject relevant parent memories into sub-agent context
 *  - onSubagentEnded: capture facts from finished sub-agent session
 *  - assemble: pass-through (autoRecall handles injection via before_agent_start)
 *  - ingest: no-op (SessionManager owns persistence)
 *
 * Feature detection: if registerContextEngine is absent the module exports a
 * no-op so callers do not need to guard on their side.
 */

import { access, readFile } from "node:fs/promises";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { HybridMemoryConfig } from "../config.js";
import type { MemoryEntry } from "../types/memory.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";
import { runPreConsolidationFlush } from "./pre-consolidation-flush.js";
import { estimateTokenCount, serializeFactForContext } from "./retrieval-orchestrator.js";

// ---------------------------------------------------------------------------
// Auto-capture: outcome phrase patterns for episodic memory (#781)
// ---------------------------------------------------------------------------

/**
 * Outcome phrase → EpisodeOutcome mapping.
 * Scanned in session JSONL during compaction to auto-create episode records.
 * Order matters: more specific patterns should come before generic ones.
 */
const OUTCOME_PATTERNS: Array<{
  pattern: RegExp;
  outcome: "success" | "failure" | "partial" | "unknown";
  eventTemplate: (phrase: string, context: string) => string;
}> = [
  // Success patterns
  {
    pattern: /✅?\s*merged\b/i,
    outcome: "success",
    eventTemplate: (_p, ctx) => `PR/branch merged: ${ctx.slice(0, 120).trim()}`,
  },
  {
    pattern: /✅?\s*(?:successfully\s+)?(?:deployed|deploy\b)/i,
    outcome: "success",
    eventTemplate: (_p, ctx) => `Deployment succeeded: ${ctx.slice(0, 120).trim()}`,
  },
  {
    pattern: /✅?\s*(?:passed|tests?\s+passed|test\s+pass)/i,
    outcome: "success",
    eventTemplate: (_p, ctx) => `Tests passed: ${ctx.slice(0, 120).trim()}`,
  },
  {
    pattern: /🔧\s*fixed\b/i,
    outcome: "success",
    eventTemplate: (_p, ctx) => `Issue fixed: ${ctx.slice(0, 120).trim()}`,
  },
  {
    pattern: /\b(?:successfully\s+)?completed\b/i,
    outcome: "success",
    eventTemplate: (_p, ctx) => `Task completed: ${ctx.slice(0, 120).trim()}`,
  },
  {
    pattern: /✅?\s*(?:resolved|fix(?:ed)?)\b/i,
    outcome: "success",
    eventTemplate: (_p, ctx) => `Resolved: ${ctx.slice(0, 120).trim()}`,
  },
  // Failure patterns
  {
    pattern: /❌\s*(?:failed|failure|error\b)/i,
    outcome: "failure",
    eventTemplate: (_p, ctx) => `Failed: ${ctx.slice(0, 120).trim()}`,
  },
  {
    pattern: /\b(?:FAILED|FAILURE|CRASH(?:ed)?)\b/i,
    outcome: "failure",
    eventTemplate: (_p, ctx) => `Failed: ${ctx.slice(0, 120).trim()}`,
  },
  {
    pattern: /\b(?:\berror\b|\bfailed\b).*(?:during|when|in|while)\b/i,
    outcome: "failure",
    eventTemplate: (_p, ctx) => `Error encountered: ${ctx.slice(0, 120).trim()}`,
  },
  // Partial patterns
  {
    pattern: /⚠️?\s*partial(?:ly)?\b/i,
    outcome: "partial",
    eventTemplate: (_p, ctx) => `Partial result: ${ctx.slice(0, 120).trim()}`,
  },
  {
    pattern: /\b(?:partial(?:ly)?|incomplete)\b/i,
    outcome: "partial",
    eventTemplate: (_p, ctx) => `Partial result: ${ctx.slice(0, 120).trim()}`,
  },
];

/**
 * Extract readable text from a session JSONL file for episode scanning.
 */
async function extractTextFromSessionFile(sessionFile: string): Promise<string> {
  try {
    await access(sessionFile);
  } catch {
    return "";
  }
  try {
    const content = await readFile(sessionFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const parts: string[] = [];
    for (const line of lines) {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      const rec = obj as Record<string, unknown>;
      // Prefer structured outcome hints when present (less fragile than emoji scans — #899).
      const structuredOutcome = rec.outcome ?? rec.episodeOutcome;
      if (structuredOutcome === "success" || structuredOutcome === "failure" || structuredOutcome === "partial") {
        parts.push(`[structured outcome=${structuredOutcome}]`);
      }
      const msg = rec.message as Record<string, unknown> | undefined;
      if (!msg || typeof msg !== "object") continue;
      const text = (msg.content as string) || (msg.text as string) || "";
      if (text) parts.push(text);
    }
    return parts.join(" ");
  } catch {
    return "";
  }
}

/**
 * Scan session text for outcome-indicating phrases and create episode records.
 * Called during session compaction to auto-capture significant events.
 * Returns the number of episodes created.
 */
async function autoCaptureEpisodes(
  factsDb: FactsDB,
  sessionFile: string,
  sessionId: string,
  logger: { debug?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<number> {
  const text = await extractTextFromSessionFile(sessionFile);
  if (!text) return 0;

  // Track which patterns have already fired to avoid duplicate episodes for the same phrase
  const seen = new Set<string>();
  let created = 0;

  for (const { pattern, outcome, eventTemplate } of OUTCOME_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const phrase = match[0];
    const contextKey = phrase.toLowerCase().slice(0, 50);
    if (seen.has(contextKey)) continue;
    seen.add(contextKey);

    try {
      const contextSnippet = text.slice(Math.max(0, text.indexOf(phrase) - 20), text.indexOf(phrase) + 100);
      const event = eventTemplate(phrase, contextSnippet);
      // Deduplicate: don't create the same episode event within this session
      factsDb.recordEpisode({
        event,
        outcome,
        context: contextSnippet.slice(0, 500),
        sessionId,
        tags: ["auto-captured"],
      });
      created++;
      logger.debug?.(`memory-hybrid: auto-captured episode [${outcome}]: ${event.slice(0, 80)}`);
    } catch (err) {
      logger.warn?.(`memory-hybrid: auto-capture episode failed: ${err}`);
    }
  }

  return created;
}

// ---------------------------------------------------------------------------
// Types (local stubs if SDK types are unavailable)
// ---------------------------------------------------------------------------

type IngestResult = { ingested: boolean };
type AssembleResult = { messages: unknown[]; estimatedTokens: number; systemPromptAddition?: string };
type CompactResult = { ok: boolean; compacted: boolean; reason?: string; result?: unknown };
type SubagentSpawnPreparation = { rollback: () => void | Promise<void> };

interface MinimalContextEngine {
  readonly info: { id: string; name: string; version?: string; ownsCompaction?: boolean };
  ingest(p: { sessionId: string; message: unknown }): Promise<IngestResult>;
  assemble(p: { sessionId: string; messages: unknown[]; tokenBudget?: number }): Promise<AssembleResult>;
  compact(p: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
  }): Promise<CompactResult>;
  prepareSubagentSpawn?(p: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;
  onSubagentEnded?(p: { childSessionKey: string; reason: string }): Promise<void>;
  dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Engine implementation
// ---------------------------------------------------------------------------

export interface ContextEngineOptions {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  wal: WriteAheadLog | null;
  embeddings: EmbeddingProvider;
  cfg: HybridMemoryConfig;
  logger: { info?: (m: string) => void; warn?: (m: string) => void; debug?: (m: string) => void };
  pluginVersion?: string;
}

// ---------------------------------------------------------------------------
// Context block builder
// ---------------------------------------------------------------------------

/**
 * Build a structured memory context block from a list of facts.
 *
 * Uses `serializeFactForContext` for each entry (same format as the
 * retrieval pipeline) and respects the optional `tokenBudget` cap.
 *
 * @param facts       - Ordered list of MemoryEntry values, best-first.
 * @param header      - HTML comment tag used as the opening/closing marker.
 * @param label       - Human-readable label for the block heading.
 * @param tokenBudget - Optional max tokens; entries are skipped once the
 *                      budget is exceeded.
 * @returns The complete context block string, or `null` when `facts` is empty.
 */
export function buildContextBlock(
  facts: MemoryEntry[],
  header: string,
  label: string,
  tokenBudget?: number,
): string | null {
  if (facts.length === 0) return null;

  const lines: string[] = [`<!-- memory-hybrid: ${header} -->`, label];
  const closingLine = `<!-- /memory-hybrid: ${header} -->`;

  const baseText = [...lines, closingLine].join("\n");
  let currentTokens = estimateTokenCount(baseText);

  if (tokenBudget !== undefined && currentTokens > tokenBudget) {
    return null;
  }

  let addedFacts = 0;
  for (const entry of facts) {
    const serialized = serializeFactForContext(entry);
    const entryTokens = estimateTokenCount("\n" + serialized);
    if (tokenBudget !== undefined && currentTokens + entryTokens > tokenBudget) break;
    lines.push(serialized);
    currentTokens += entryTokens;
    addedFacts++;
  }

  if (addedFacts === 0) return null;

  lines.push(closingLine);

  // Ensure the final joined string strictly satisfies the budget
  while (lines.length > 3 && tokenBudget !== undefined && estimateTokenCount(lines.join("\n")) > tokenBudget) {
    lines.splice(lines.length - 2, 1);
  }

  if (lines.length <= 3 && tokenBudget !== undefined && estimateTokenCount(lines.join("\n")) > tokenBudget) {
    return null;
  }

  return lines.join("\n");
}

/**
 * Minimal ContextEngine that integrates hybrid-memory into the OpenClaw
 * context lifecycle. Designed for backward compatibility — every method
 * degrades gracefully if dependencies are missing.
 */
export class HybridMemoryContextEngine implements MinimalContextEngine {
  readonly info = {
    id: "hybrid-memory",
    name: "OpenClaw Hybrid Memory",
    version: undefined as string | undefined,
    // We do NOT own compaction — the legacy compaction pipeline handles it.
    // We just flush pending state before it runs.
    ownsCompaction: false,
  };

  constructor(private readonly opts: ContextEngineOptions) {
    this.info.version = opts.pluginVersion;
  }

  /** no-op: SessionManager handles message persistence. */
  async ingest(_params: { sessionId: string; message: unknown }): Promise<IngestResult> {
    return { ingested: false };
  }

  /**
   * Budget-aware context assembly.
   *
   * Fetches the top-N most recent/important facts and injects them as a
   * `systemPromptAddition` block so the SDK can place them in the system
   * prompt. The `tokenBudget` parameter (exposed by SDK #274) caps the
   * total context size returned; when absent, a conservative 1000-token
   * default is used.
   *
   * The autoRecall hook already handles per-turn injection via
   * `before_agent_start → prependContext`; this method provides the same
   * information to the ContextEngine slot so future SDK versions can
   * manage injection centrally.
   */
  async assemble(params: { sessionId: string; messages: unknown[]; tokenBudget?: number }): Promise<AssembleResult> {
    const { factsDb, cfg, logger } = this.opts;
    const budget = params.tokenBudget ?? cfg.autoRecall?.maxTokens ?? 1000;

    try {
      const limit = cfg.autoRecall?.limit ?? 10;
      const facts = factsDb.list(Math.min(limit, 15));

      if (facts.length === 0) {
        return { messages: params.messages, estimatedTokens: 0 };
      }

      const block = buildContextBlock(facts, "session-context", "Relevant memories for this session:", budget);
      if (!block) {
        return { messages: params.messages, estimatedTokens: 0 };
      }

      const estimatedTokens = estimateTokenCount(block);
      logger.debug?.(
        `memory-hybrid: context-engine assemble — injecting ${facts.length} facts, ~${estimatedTokens} tokens (budget=${budget})`,
      );

      return {
        messages: params.messages,
        estimatedTokens,
        systemPromptAddition: block,
      };
    } catch (err) {
      logger.warn?.(`memory-hybrid: context-engine assemble failed (non-fatal): ${err}`);
      return { messages: params.messages, estimatedTokens: 0 };
    }
  }

  /**
   * Pre-compaction flush:
   *  1. Drain the WAL — replay pending entries to SQLite (and LanceDB if embeddings available)
   *  2. Snapshot session-scoped facts to WAL for durability
   */
  async compact(_params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
  }): Promise<CompactResult> {
    const { logger, wal, factsDb, vectorDb, embeddings } = this.opts;
    try {
      // 1. Replay pending WAL entries — commit any writes that didn't complete before crash/compaction
      const { committed: walCommitted, skipped: walSkipped } = await runPreConsolidationFlush(
        { wal, factsDb, vectorDb, embeddings },
        logger,
        "context-engine compact",
      );

      // 2. Auto-capture episodic events from session log (#781)
      //    Scans the session JSONL for outcome-indicating phrases (✅ merged, ❌ failed, etc.)
      //    and creates episode records for significant events.
      let episodesCreated = 0;
      try {
        episodesCreated = await autoCaptureEpisodes(factsDb, _params.sessionFile, _params.sessionId, logger);
        if (episodesCreated > 0) {
          logger.info?.(`memory-hybrid: auto-captured ${episodesCreated} episode(s) from session compaction`);
        }
      } catch (err) {
        logger.warn?.(`memory-hybrid: episode auto-capture failed (non-fatal): ${err}`);
      }

      // 3. Count total facts and build a brief post-compaction memory summary.
      //
      //    The summary is returned in the `result` field so that SDK versions which
      //    consume it can inject the top facts into the post-compaction context.
      //    On older runtimes that only read `ok`/`compacted`/`reason`, the extra
      //    fields are ignored — no behaviour change.
      //
      //    TODO(SDK #275): When the SDK exposes a dedicated `contextAddition` field
      //    on CompactResult, move the summary string there instead of nesting it in
      //    `result`. Until then, `result.memorySummary` serves as the best-effort
      //    injection surface.
      let sessionFacts = 0;
      let memorySummary: string | undefined;
      // Declare topFacts in outer scope so it's accessible in the return statement below.
      let topFacts: ReturnType<typeof factsDb.list> = [];
      try {
        sessionFacts = factsDb.getCount();
        topFacts = factsDb.list(8);
        const block = buildContextBlock(
          topFacts,
          "post-compaction memory summary",
          "Key memories retained across compaction:",
          _params.tokenBudget,
        );
        if (block) memorySummary = block;
      } catch {
        // Non-fatal
      }

      logger.debug?.(
        `memory-hybrid: context-engine compact — pre-compaction flush done, sessionFacts≈${sessionFacts}, episodes≈${episodesCreated}`,
      );
      return {
        ok: true,
        compacted: false,
        reason: `flushed pending state (wal: ${walCommitted} committed, ${episodesCreated} episodes auto-captured)`,
        // Extended result field: SDK ≥ 2026.3.8 may inject memorySummary into context.
        result: memorySummary
          ? { topFacts, factCount: sessionFacts, memorySummary, episodesCreated }
          : { factCount: sessionFacts, episodesCreated },
      };
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "context-engine",
        operation: "compact",
      });
      logger.warn?.(`memory-hybrid: context-engine compact failed: ${err}`);
      return { ok: false, compacted: false, reason: String(err) };
    }
  }

  /**
   * Pre-spawn preparation: inject relevant parent memories into sub-agent context.
   *
   * Fetches the top-N most recent/important facts from the parent session and
   * returns them as a `contextAddition` string for the SDK to inject into the
   * sub-agent's initial context.
   *
   * Guard against double-processing: the before_agent_start hook also injects
   * memories for the child session. This method only fires when the SDK calls
   * the ContextEngine API directly (OpenClaw ≥ 2026.3.8). On older runtimes the
   * method is never called, so there is no duplication risk.
   */
  async prepareSubagentSpawn(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined> {
    const { factsDb, cfg, logger } = this.opts;
    try {
      // Fetch top-N recent/important facts to seed the sub-agent's context
      const limit = cfg.autoRecall?.limit ?? 10;
      const topFacts = factsDb.list(Math.min(limit, 15));

      if (topFacts.length === 0) {
        logger.debug?.(`memory-hybrid: prepareSubagentSpawn — no facts to inject for child=${params.childSessionKey}`);
        return { rollback: async () => {} };
      }

      // contextAddition is a non-standard field on the return type — populated so that
      // SDK versions that support it can inject the block; older versions ignore it.
      // Uses serializeFactForContext for consistent formatting with the retrieval pipeline.
      const contextAddition = buildContextBlock(
        topFacts,
        `parent context injected for subagent ${params.childSessionKey}`,
        `Relevant memories from parent session (${params.parentSessionKey}):`,
      );

      logger.debug?.(
        `memory-hybrid: prepareSubagentSpawn — injecting ${topFacts.length} facts for child=${params.childSessionKey}`,
      );

      return {
        rollback: async () => {
          // No state was mutated; rollback is a no-op.
          logger.debug?.(
            `memory-hybrid: prepareSubagentSpawn rollback — no state to revert for child=${params.childSessionKey}`,
          );
        },
        // Extended field: injected into sub-agent context by SDK ≥ 2026.3.8.
        // null when buildContextBlock returns null (empty facts list — already guarded above).
        ...(contextAddition !== null ? { contextAddition } : {}),
      } as SubagentSpawnPreparation & { contextAddition?: string };
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "context-engine",
        operation: "prepare-subagent-spawn",
      });
      logger.warn?.(`memory-hybrid: prepareSubagentSpawn failed (non-fatal): ${err}`);
      return undefined;
    }
  }

  /**
   * Post-subagent cleanup: capture any session-scoped facts created by the sub-agent
   * and promote them to the appropriate scope.
   *
   * Guard against double-processing: OpenClaw's typed **`subagent_ended`** hook
   * (`lifecycle/stage-cleanup.ts`) only performs ACTIVE-TASKS.md checkpointing — not fact capture.
   * This method provides a lightweight ContextEngine callback; primary fact capture is the
   * child session's **agent_end** autoCapture path. If a fact is already in the store it will be
   * skipped by the hasDuplicate check when that pipeline exists.
   *
   * NOTE: The current SDK interface does not pass the sub-agent's result text here.
   * When the SDK exposes result text, parse it using the existing autoCapture logic
   * (see lifecycle/hooks.ts agent_end handler).
   */
  async onSubagentEnded(params: { childSessionKey: string; reason: string }): Promise<void> {
    const { factsDb, logger } = this.opts;
    try {
      // Count facts captured from the child session (written to the shared store by the
      // child's own agent_end autoCapture hook while the child session was running).
      const capturedCount = factsDb.countBySource(params.childSessionKey);

      if (capturedCount > 0) {
        logger.info?.(
          `memory-hybrid: context-engine onSubagentEnded — child=${params.childSessionKey} reason=${params.reason} childFacts=${capturedCount}`,
        );
      } else {
        logger.debug?.(
          `memory-hybrid: context-engine onSubagentEnded — child=${params.childSessionKey} reason=${params.reason} childFacts=0 (no auto-captured facts found for this session key)`,
        );
      }

      // TODO(SDK #273): Implement result-text fact extraction once the SDK exposes it.
      //
      // The current hook signature only provides { childSessionKey, reason }.
      // To implement full result-text capture, the SDK must expose one of:
      //   params.resultText: string        — the final assistant text from the sub-agent
      //   params.messages: unknown[]       — full message log (same shape as agent_end event)
      //
      // When available, mirror the agent_end autoCapture pipeline from lifecycle/hooks.ts:
      //   1. Iterate messages, extract text/content blocks
      //   2. Filter via shouldCapture() (needs to be added to ContextEngineOptions)
      //   3. Classify with detectCategory() / classifyMemoryOperation()
      //   4. Deduplicate via factsDb.hasDuplicate()
      //   5. Store with source=params.childSessionKey, scope="global"
      //
      // Until then, all sub-agent fact capture is delegated to:
      //   (a) The child session's own agent_end autoCapture hook (primary path — runs
      //       inside the child's session and writes directly to the shared FactsDB)
      //   (b) The typed subagent_ended hook in lifecycle/stage-cleanup.ts (ACTIVE-TASKS.md only; issue #966)
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "context-engine",
        operation: "on-subagent-ended",
      });
      logger.warn?.(`memory-hybrid: onSubagentEnded failed (non-fatal): ${err}`);
    }
  }

  async dispose(): Promise<void> {
    // No owned resources to dispose.
  }
}

// ---------------------------------------------------------------------------
// Registration helper (feature-detected)
// ---------------------------------------------------------------------------

/**
 * Attempt to register HybridMemoryContextEngine with the OpenClaw plugin SDK.
 *
 * Safe to call even when:
 *  - The registerContextEngine export doesn't exist (older OpenClaw versions)
 *  - The import fails (ESM resolution error in older runtime)
 *
 * Returns true if registration succeeded, false otherwise.
 */
export async function registerHybridContextEngine(opts: ContextEngineOptions): Promise<boolean> {
  try {
    // Dynamic import for feature detection — avoids hard dependency on the API.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk: any = await import("openclaw/plugin-sdk/core").catch(() => null);
    if (!sdk) {
      opts.logger.debug?.("memory-hybrid: openclaw/plugin-sdk not available; skipping ContextEngine registration");
      return false;
    }

    const { registerContextEngine } = sdk as {
      registerContextEngine?: (id: string, factory: () => MinimalContextEngine) => void;
    };

    if (typeof registerContextEngine !== "function") {
      opts.logger.debug?.("memory-hybrid: registerContextEngine not found in SDK; skipping ContextEngine registration");
      return false;
    }

    const engine = new HybridMemoryContextEngine(opts);
    registerContextEngine("hybrid-memory", () => engine);
    opts.logger.info?.("memory-hybrid: ContextEngine registered (id=hybrid-memory)");
    return true;
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "context-engine",
      operation: "register",
    });
    opts.logger.warn?.(`memory-hybrid: ContextEngine registration failed (non-fatal): ${err}`);
    return false;
  }
}
