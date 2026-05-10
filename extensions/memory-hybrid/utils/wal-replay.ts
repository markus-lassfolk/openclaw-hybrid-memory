/**
 * WAL Replay Utilities
 *
 * Shared logic for replaying Write-Ahead Log entries to SQLite and LanceDB.
 * Used by both the ContextEngine compact() method and the before_compaction hook.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { capturePluginError } from "../services/error-reporter.js";

export interface WalReplayResult {
  committed: number;
  skipped: number;
}

function safeString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function safeNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

function safeStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0);
  return out.length > 0 ? out : null;
}

function findExistingFactIdForWal(factsDb: FactsDB, text: string, source: string | null): string | null {
  try {
    const src = source?.trim() || "conversation";
    const row = factsDb
      .getRawDb()
      .prepare(
        "SELECT id FROM facts WHERE text = ? AND source = ? AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(text, src) as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

async function ensureVectorAndEmbeddingMeta(opts: {
  factId: string;
  text: string;
  category: string;
  importance: number;
  vector: number[] | null;
  vectorDb?: VectorDB;
  embeddings?: EmbeddingProvider | null;
  factsDb: FactsDB;
}): Promise<void> {
  const { factId, text, category, importance, vector, vectorDb, embeddings, factsDb } = opts;
  if (!vectorDb) return;

  const embedAndStore = async (): Promise<number[] | null> => {
    if (!embeddings) return null;
    try {
      const v = await embeddings.embed(text);
      await vectorDb.store({
        id: factId,
        text,
        vector: Array.from(v),
        importance,
        category,
      });
      if (embeddings.modelName) {
        factsDb.setEmbeddingModel(factId, embeddings.modelName);
        factsDb.storeEmbedding(factId, embeddings.modelName, "canonical", new Float32Array(v), v.length);
      }
      return Array.from(v);
    } catch {
      return null;
    }
  };

  try {
    if (vector && vector.length > 0) {
      await vectorDb.store({
        id: factId,
        text,
        vector,
        importance,
        category,
      });
      if (embeddings?.modelName) {
        factsDb.setEmbeddingModel(factId, embeddings.modelName);
        factsDb.storeEmbedding(
          factId,
          embeddings.modelName,
          "canonical",
          new Float32Array(vector),
          vector.length,
        );
      }
      return;
    }
  } catch {
    // Non-fatal: fall back to re-embed if possible.
  }

  await embedAndStore();
}

/**
 * Replay all pending WAL entries to the facts database and optionally to the vector database.
 *
 * @param wal - Write-Ahead Log instance
 * @param factsDb - Facts database for storing entries
 * @param vectorDb - Optional vector database for storing embeddings
 * @param embeddings - Optional embedding provider for generating vectors
 * @returns Object with committed and skipped counts
 */
export async function replayWalEntries(
  wal: WriteAheadLog,
  factsDb: FactsDB,
  vectorDb?: VectorDB,
  embeddings?: EmbeddingProvider | null,
): Promise<WalReplayResult> {
  let committed = 0;
  let skipped = 0;

  // Only replay entries within the WAL's maxAge window.
  // Older entries are handled by WAL prune routines and should not be resurrected.
  const walEntries = await wal.getValidEntries();
  const nowSec = Math.floor(Date.now() / 1000);

  for (const entry of walEntries) {
    try {
      if (entry.operation === "store" && entry.data?.text) {
        const text = safeString(entry.data.text) ?? "";
        const source = safeString(entry.data.source) ?? "conversation";
        const category = (safeString(entry.data.category) ?? "other") as import("../config.js").MemoryCategory;
        const importance = safeNumber(entry.data.importance) ?? 0.5;
        const why = safeString(entry.data.why);
        const scope = safeString(entry.data.scope) as "global" | "user" | "agent" | "session" | null;
        const scopeTarget = safeString(entry.data.scopeTarget);
        const summary = safeString(entry.data.summary);
        const tags = safeStringArray(entry.data.tags) ?? undefined;
        const decayFreezeUntil = safeNumber(entry.data.decayFreezeUntil);
        const preserveUntil = safeNumber(entry.data.preserveUntil);
        const preserveTags = safeStringArray(entry.data.preserveTags);
        const provenanceSession = safeString(entry.data.provenanceSession);
        const sourceTurn = safeNumber(entry.data.sourceTurn);
        const extractionMethod = safeString(entry.data.extractionMethod);
        const extractionConfidence = safeNumber(entry.data.extractionConfidence);
        const provenanceJson = safeString(entry.data.provenanceJson);
        const sourceSessions = safeString(entry.data.sourceSessions);

        const precomputedVector = Array.isArray(entry.data.vector)
          ? (entry.data.vector as number[]).filter((n) => typeof n === "number" && Number.isFinite(n))
          : null;

        // Idempotent replay: if the fact already exists, still ensure vector/embedding metadata.
        const existingId = findExistingFactIdForWal(factsDb, text, source);
        if (existingId) {
          await ensureVectorAndEmbeddingMeta({
            factId: existingId,
            text,
            category,
            importance,
            vector: precomputedVector,
            vectorDb,
            embeddings,
            factsDb,
          });
          skipped++;
          await wal.remove(entry.id);
          continue;
        }

        const stored = factsDb.store({
          text,
          why,
          category,
          importance,
          entity: safeString(entry.data.entity) ?? null,
          key: safeString(entry.data.key) ?? null,
          value: safeString(entry.data.value) ?? null,
          source,
          decayClass: safeString(entry.data.decayClass) as import("../config.js").DecayClass | undefined,
          summary,
          tags,
          scope: (scope ?? undefined) as "global" | "user" | "agent" | "session" | undefined,
          scopeTarget: scope ? scopeTarget : null,
          sourceSessions: sourceSessions ?? undefined,
          provenanceSession: provenanceSession ?? undefined,
          sourceTurn: sourceTurn ?? undefined,
          extractionMethod: extractionMethod ?? undefined,
          extractionConfidence: extractionConfidence ?? undefined,
          decayFreezeUntil: decayFreezeUntil ?? undefined,
          preserveUntil: preserveUntil ?? undefined,
          preserveTags: preserveTags ?? undefined,
          provenanceJson: provenanceJson ?? undefined,
        });

        await ensureVectorAndEmbeddingMeta({
          factId: stored.id,
          text: stored.text,
          category: stored.category,
          importance: stored.importance,
          vector: precomputedVector,
          vectorDb,
          embeddings,
          factsDb,
        });

        committed++;
        await wal.remove(entry.id);
      } else if (entry.operation === "update" && entry.targetId && entry.data?.text) {
        const targetId = entry.targetId;
        const text = safeString(entry.data.text) ?? "";
        const source = safeString(entry.data.source) ?? "conversation";
        const category = (safeString(entry.data.category) ?? "other") as import("../config.js").MemoryCategory;
        const importance = safeNumber(entry.data.importance) ?? 0.5;
        const why = safeString(entry.data.why);
        const scope = safeString(entry.data.scope) as "global" | "user" | "agent" | "session" | null;
        const scopeTarget = safeString(entry.data.scopeTarget);
        const summary = safeString(entry.data.summary);
        const tags = safeStringArray(entry.data.tags) ?? undefined;
        const decayFreezeUntil = safeNumber(entry.data.decayFreezeUntil);
        const preserveUntil = safeNumber(entry.data.preserveUntil);
        const preserveTags = safeStringArray(entry.data.preserveTags);
        const provenanceSession = safeString(entry.data.provenanceSession);
        const sourceTurn = safeNumber(entry.data.sourceTurn);
        const extractionMethod = safeString(entry.data.extractionMethod);
        const extractionConfidence = safeNumber(entry.data.extractionConfidence);
        const provenanceJson = safeString(entry.data.provenanceJson);
        const sourceSessions = safeString(entry.data.sourceSessions);

        const precomputedVector = Array.isArray(entry.data.vector)
          ? (entry.data.vector as number[]).filter((n) => typeof n === "number" && Number.isFinite(n))
          : null;

        const target = factsDb.getById(targetId);
        if (!target) {
          // Target fact already gone — nothing safe to replay.
          skipped++;
          await wal.remove(entry.id);
          continue;
        }

        // Idempotent replay: if a matching replacement fact exists, ensure vector and link it.
        const existingId = findExistingFactIdForWal(factsDb, text, source);
        if (existingId && existingId !== targetId) {
          factsDb.supersede(targetId, existingId);
          await ensureVectorAndEmbeddingMeta({
            factId: existingId,
            text,
            category,
            importance,
            vector: precomputedVector,
            vectorDb,
            embeddings,
            factsDb,
          });
          skipped++;
          await wal.remove(entry.id);
          continue;
        }

        if (factsDb.hasDuplicate(text)) {
          skipped++;
          await wal.remove(entry.id);
          continue;
        }

        const stored = factsDb.store({
          text,
          why,
          category,
          importance,
          entity: safeString(entry.data.entity) ?? null,
          key: safeString(entry.data.key) ?? null,
          value: safeString(entry.data.value) ?? null,
          source,
          decayClass: safeString(entry.data.decayClass) as import("../config.js").DecayClass | undefined,
          summary,
          tags,
          validFrom: nowSec,
          supersedesId: targetId,
          scope: (scope ?? undefined) as "global" | "user" | "agent" | "session" | undefined,
          scopeTarget: scope ? scopeTarget : null,
          sourceSessions: sourceSessions ?? undefined,
          provenanceSession: provenanceSession ?? undefined,
          sourceTurn: sourceTurn ?? undefined,
          extractionMethod: extractionMethod ?? undefined,
          extractionConfidence: extractionConfidence ?? undefined,
          decayFreezeUntil: decayFreezeUntil ?? undefined,
          preserveUntil: preserveUntil ?? undefined,
          preserveTags: preserveTags ?? undefined,
          provenanceJson: provenanceJson ?? undefined,
        });
        factsDb.supersede(targetId, stored.id);

        await ensureVectorAndEmbeddingMeta({
          factId: stored.id,
          text: stored.text,
          category: stored.category,
          importance: stored.importance,
          vector: precomputedVector,
          vectorDb,
          embeddings,
          factsDb,
        });

        committed++;
        await wal.remove(entry.id);
      } else if (entry.operation === "update") {
        // Legacy UPDATE lines without targetId cannot be replayed safely.
        skipped++;
        await wal.remove(entry.id);
      } else if (entry.operation === "delete") {
        // Delete WAL entries cannot be reliably replayed: the WAL data structure stores
        // text content in data.text, not the target fact UUID. Replaying would pass the
        // memory text as a UUID, causing an "Invalid UUID format" error (see issue #334).
        // Skip and remove to prevent unbounded WAL growth.
        skipped++;
        await wal.remove(entry.id);
      }
    } catch (err) {
      // Non-fatal: log the failure (with entry id + operation for diagnostics) and continue
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "wal-replay",
        operation: `replay-${entry.operation ?? "unknown"}`,
        entryId: entry.id,
      });
      // Leave the entry in the WAL so it can be retried (or pruned as stale).
    }
  }

  return { committed, skipped };
}
