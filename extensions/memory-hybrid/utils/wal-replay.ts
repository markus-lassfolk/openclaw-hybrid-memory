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

	const walEntries = await wal.readAll();

	for (const entry of walEntries) {
		try {
			if (entry.operation === "store" && entry.data?.text) {
				// Skip if already persisted (idempotent replay)
				if (!factsDb.hasDuplicate(entry.data.text as string)) {
					const stored = factsDb.store({
						text: entry.data.text as string,
						category:
							(entry.data.category as import("../config.js").MemoryCategory) ??
							"other",
						importance: (entry.data.importance as number) ?? 0.5,
						entity: (entry.data.entity as string | null | undefined) ?? null,
						key: (entry.data.key as string | null | undefined) ?? null,
						value: (entry.data.value as string | null | undefined) ?? null,
						source: (entry.data.source as string) ?? "wal-replay",
						decayClass: entry.data.decayClass as
							| import("../config.js").DecayClass
							| undefined,
						summary: (entry.data.summary as string | null | undefined) ?? null,
						tags: (entry.data.tags as string[] | undefined) ?? undefined,
					});

					// Optionally persist vector if already computed in WAL entry
					const precomputedVector = entry.data.vector as number[] | undefined;
					if (vectorDb && precomputedVector && precomputedVector.length > 0) {
						try {
							await vectorDb.store({
								id: stored.id,
								text: stored.text,
								vector: precomputedVector,
								importance: stored.importance,
								category: stored.category,
							});
						} catch {
							// Vector store failure is non-fatal — SQLite entry is durable
						}
					} else if (vectorDb && embeddings) {
						// Re-embed on WAL replay if no vector was stored
						try {
							const vector = await embeddings.embed(stored.text);
							await vectorDb.store({
								id: stored.id,
								text: stored.text,
								vector: Array.from(vector),
								importance: stored.importance,
								category: stored.category,
							});
						} catch {
							// Non-fatal
						}
					}
					committed++;
					await wal.remove(entry.id);
				} else {
					skipped++;
					await wal.remove(entry.id);
				}
			} else if (
				entry.operation === "update" &&
				entry.targetId &&
				entry.data?.text
			) {
				const targetId = entry.targetId;
				if (!factsDb.getById(targetId)) {
					skipped++;
					await wal.remove(entry.id);
				} else if (!factsDb.hasDuplicate(entry.data.text as string)) {
					const stored = factsDb.store({
						text: entry.data.text as string,
						category:
							(entry.data.category as import("../config.js").MemoryCategory) ??
							"other",
						importance: (entry.data.importance as number) ?? 0.5,
						entity: (entry.data.entity as string | null | undefined) ?? null,
						key: (entry.data.key as string | null | undefined) ?? null,
						value: (entry.data.value as string | null | undefined) ?? null,
						source: (entry.data.source as string) ?? "wal-replay",
						decayClass: entry.data.decayClass as
							| import("../config.js").DecayClass
							| undefined,
						summary: (entry.data.summary as string | null | undefined) ?? null,
						tags: (entry.data.tags as string[] | undefined) ?? undefined,
						supersedesId: targetId,
					});
					factsDb.supersede(targetId, stored.id);
					const precomputedVector = entry.data.vector as number[] | undefined;
					if (vectorDb && precomputedVector && precomputedVector.length > 0) {
						try {
							await vectorDb.store({
								id: stored.id,
								text: stored.text,
								vector: precomputedVector,
								importance: stored.importance,
								category: stored.category,
							});
						} catch {
							// non-fatal
						}
					} else if (vectorDb && embeddings) {
						try {
							const vector = await embeddings.embed(stored.text);
							await vectorDb.store({
								id: stored.id,
								text: stored.text,
								vector: Array.from(vector),
								importance: stored.importance,
								category: stored.category,
							});
						} catch {
							// non-fatal
						}
					}
					committed++;
					await wal.remove(entry.id);
				} else {
					skipped++;
					await wal.remove(entry.id);
				}
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
		}
	}

	return { committed, skipped };
}
