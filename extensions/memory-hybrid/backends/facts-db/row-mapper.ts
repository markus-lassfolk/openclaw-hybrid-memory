/**
 * Map SQLite fact rows to MemoryEntry (Issue #954).
 */
import type { DecayClass, MemoryCategory } from "../../config.js";
import { capturePluginError } from "../../services/error-reporter.js";
import type { MemoryEntry, MemoryTier } from "../../types/memory.js";
import { parseTags } from "../../utils/tags.js";

/** Convert a raw SQLite row to MemoryEntry. */
export function rowToMemoryEntry(row: Record<string, unknown>): MemoryEntry {
	return {
		id: row.id as string,
		text: row.text as string,
		why: (row.why as string) ?? null,
		category: row.category as MemoryCategory,
		importance: row.importance as number,
		entity: (row.entity as string) || null,
		key: (row.key as string) || null,
		value: (row.value as string) || null,
		source: row.source as string,
		createdAt: row.created_at as number,
		sourceDate: (row.source_date as number) ?? undefined,
		tags: parseTags(row.tags as string | null),
		decayClass: (row.decay_class as DecayClass) || "stable",
		expiresAt: (row.expires_at as number) || null,
		lastConfirmedAt: (row.last_confirmed_at as number) || 0,
		confidence: (row.confidence as number) || 1.0,
		summary: (row.summary as string) || undefined,
		recallCount: (row.recall_count as number) || 0,
		lastAccessed: (row.last_accessed as number) || null,
		accessCount: (row.access_count as number) || 0,
		lastAccessedAt: (row.last_accessed_at as string) || null,
		supersededAt: (row.superseded_at as number) || null,
		supersededBy: (row.superseded_by as string) || null,
		validFrom: (row.valid_from as number) ?? undefined,
		validUntil: (row.valid_until as number) ?? undefined,
		supersedesId: (row.supersedes_id as string) ?? undefined,
		tier: (row.tier as MemoryTier) ?? undefined,
		scope: (row.scope as "global" | "user" | "agent" | "session") ?? "global",
		scopeTarget: (row.scope_target as string) || null,
		procedureType: (row.procedure_type as "positive" | "negative") ?? undefined,
		successCount: (row.success_count as number) ?? undefined,
		lastValidated: (row.last_validated as number) ?? undefined,
		sourceSessions: (row.source_sessions as string) ?? undefined,
		embeddingModel: (row.embedding_model as string) ?? null,
		provenanceSession: (row.provenance_session as string) ?? null,
		sourceTurn: (row.source_turn as number) ?? null,
		extractionMethod: (row.extraction_method as string) ?? null,
		extractionConfidence: (row.extraction_confidence as number) ?? null,
		reinforcedCount: (row.reinforced_count as number) ?? 0,
		lastReinforcedAt: (row.last_reinforced_at as number) ?? null,
		reinforcedQuotes: (() => {
			const raw = row.reinforced_quotes as string | null;
			if (!raw) return null;
			try {
				const parsed = JSON.parse(raw);
				return Array.isArray(parsed)
					? parsed.filter((q): q is string => typeof q === "string")
					: null;
			} catch (err) {
				capturePluginError(err as Error, {
					operation: "json-parse-quotes",
					severity: "info",
					subsystem: "facts",
				});
				return null;
			}
		})(),
		decayFreezeUntil: (row.decay_freeze_until as number) ?? null,
		preserveUntil: (row.preserve_until as number) ?? null,
		preserveTags: (() => {
			const raw = row.preserve_tags as string | null;
			if (!raw) return null;
			try {
				const parsed = JSON.parse(raw);
				return Array.isArray(parsed)
					? parsed.filter((q): q is string => typeof q === "string")
					: null;
			} catch {
				return null;
			}
		})(),
	};
}
