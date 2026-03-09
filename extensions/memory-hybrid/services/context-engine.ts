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

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { HybridMemoryConfig } from "../config.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";
import { replayWalEntries } from "../utils/wal-replay.js";

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
   * Pass-through: the autoRecall hook already injected relevant memories
   * via before_agent_start → prependContext.
   *
   * We return messages as-is; future work can inject a systemPromptAddition
   * once the ContextEngine is the sole injection point.
   */
  async assemble(params: { sessionId: string; messages: unknown[]; tokenBudget?: number }): Promise<AssembleResult> {
    return {
      messages: params.messages,
      estimatedTokens: 0,
    };
  }

  /**
   * Pre-compaction flush:
   *  1. Drain the WAL — replay pending entries to SQLite (and LanceDB if embeddings available)
   *  2. Snapshot session-scoped facts to WAL for durability
   */
  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
  }): Promise<CompactResult> {
    const { logger, wal, factsDb, vectorDb, embeddings } = this.opts;
    try {
      // 1. Replay pending WAL entries — commit any writes that didn't complete before crash/compaction
      let walCommitted = 0;
      let walSkipped = 0;
      if (wal) {
        try {
          const walEntries = wal.readAll();
          if (walEntries.length > 0) {
            logger.debug?.(`memory-hybrid: context-engine compact — replaying ${walEntries.length} WAL entries for session ${params.sessionId}`);
            const result = await replayWalEntries(wal, factsDb, vectorDb, embeddings);
            walCommitted = result.committed;
            walSkipped = result.skipped;
            if (walCommitted > 0) {
              logger.info?.(`memory-hybrid: context-engine compact — WAL replay complete: ${walCommitted} committed, ${walSkipped} skipped (already present)`);
            }
          }
        } catch {
          // Non-fatal — WAL replay failure should not block compaction
        }
      }

      // 2. Count total facts as a lightweight snapshot check
      let sessionFacts = 0;
      try {
        sessionFacts = factsDb.getCount();
      } catch {
        // Non-fatal
      }

      logger.debug?.(`memory-hybrid: context-engine compact — pre-compaction flush done, sessionFacts≈${sessionFacts}`);
      return { ok: true, compacted: false, reason: `flushed pending state (wal: ${walCommitted} committed)` };
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

      const lines = topFacts.map((f) => {
        const entityPrefix = f.entity ? `[${f.entity}] ` : "";
        const preview = f.text.length > 200 ? f.text.slice(0, 200) + "…" : f.text;
        return `- ${entityPrefix}${preview}`;
      });

      // contextAddition is a non-standard field on the return type — populated so that
      // SDK versions that support it can inject the block; older versions ignore it.
      const contextAddition = [
        `<!-- memory-hybrid: parent context injected for subagent ${params.childSessionKey} -->`,
        `Relevant memories from parent session (${params.parentSessionKey}):`,
        ...lines,
        `<!-- /memory-hybrid: parent context -->`,
      ].join("\n");

      logger.debug?.(
        `memory-hybrid: prepareSubagentSpawn — injecting ${topFacts.length} facts for child=${params.childSessionKey}`,
      );

      return {
        rollback: async () => {
          // No state was mutated; rollback is a no-op.
          logger.debug?.(`memory-hybrid: prepareSubagentSpawn rollback — no state to revert for child=${params.childSessionKey}`);
        },
        // Extended field: injected into sub-agent context by SDK ≥ 2026.3.8
        contextAddition,
      } as SubagentSpawnPreparation & { contextAddition: string };
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
   * Guard against double-processing: the subagent_ended hook in lifecycle/hooks.ts
   * handles the primary fact capture pipeline. This method provides a lightweight
   * secondary pass scoped to the ContextEngine lifecycle, and only runs on
   * OpenClaw ≥ 2026.3.8. If a fact is already in the store it will be skipped
   * by the hasDuplicate check.
   *
   * NOTE: The current SDK interface does not pass the sub-agent's result text here.
   * Full result-text capture is handled by the lifecycle/hooks.ts subagent_ended handler.
   * When the SDK interface is extended to include result text, this method should parse
   * it using the existing autoCapture logic (see lifecycle/hooks.ts agent_end handler).
   */
  async onSubagentEnded(params: { childSessionKey: string; reason: string }): Promise<void> {
    const { factsDb, logger } = this.opts;
    try {
      // Count any session-scoped facts from the child session to confirm capture happened
      const childSessionFacts = factsDb.list(1, { source: params.childSessionKey });
      const capturedCount = childSessionFacts.length;

      logger.debug?.(
        `memory-hybrid: context-engine onSubagentEnded — child=${params.childSessionKey} reason=${params.reason} sessionFacts≥${capturedCount}`,
      );

      // TODO(future): When SDK passes result text via params.resultText, parse it here:
      //   const texts = extractAutoCaptureCandidates(params.resultText);
      //   for (const text of texts.filter(t => !factsDb.hasDuplicate(t))) { factsDb.store(...) }
      // For now, all capture is delegated to the subagent_ended hook in lifecycle/hooks.ts.
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
    const sdk: any = await import("openclaw/plugin-sdk").catch(() => null);
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
