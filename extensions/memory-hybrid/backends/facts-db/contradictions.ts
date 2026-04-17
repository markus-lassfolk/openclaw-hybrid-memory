/**
 * Contradiction detection and resolution (Issue #157) (Issue #954 split).
 */
import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

import { capturePluginError } from "../../services/error-reporter.js";
import type { MemoryEntry } from "../../types/memory.js";
import { createTransaction } from "../../utils/sqlite-transaction.js";
import { parseTags, serializeTags } from "../../utils/tags.js";
import { rowToMemoryEntry } from "./row-mapper.js";
import type { MemoryLinkType } from "./types.js";

export interface ContradictionRecord {
	id: string;
	factIdNew: string;
	factIdOld: string;
	detectedAt: string;
	resolved: boolean;
	resolution: "superseded" | "kept" | "merged" | null;
	oldFactOriginalConfidence?: number;
}

export function updateConfidence(
	db: DatabaseSync,
	id: string,
	delta: number,
): number | null {
	const row = db.prepare("SELECT confidence FROM facts WHERE id = ?").get(id) as
		| { confidence: number }
		| undefined;
	if (!row) return null;
	const current = row.confidence ?? 1.0;
	const updated = Math.max(0.1, Math.min(1.0, current + delta));
	db.prepare("UPDATE facts SET confidence = ? WHERE id = ?").run(updated, id);
	return updated;
}

export function setConfidenceTo(
	db: DatabaseSync,
	id: string,
	value: number,
): number | null {
	const row = db.prepare("SELECT confidence FROM facts WHERE id = ?").get(id) as
		| { confidence: number }
		| undefined;
	if (!row) return null;
	const updated = Math.max(0.1, Math.min(1, value));
	db.prepare("UPDATE facts SET confidence = ? WHERE id = ?").run(updated, id);
	return updated;
}

export function addTag(db: DatabaseSync, id: string, tag: string): void {
	const trimmed = tag.trim();
	const normalized = trimmed.toLowerCase();
	if (!normalized || normalized.includes(",")) return;
	const row = db.prepare("SELECT tags FROM facts WHERE id = ?").get(id) as
		| { tags: string | null }
		| undefined;
	if (!row) return;
	const tags = parseTags(row.tags);
	if (tags.some((t) => t.toLowerCase() === normalized)) return;
	tags.push(normalized);
	db.prepare("UPDATE facts SET tags = ? WHERE id = ?").run(
		serializeTags(tags),
		id,
	);
}

export function findConflictingFacts(
	db: DatabaseSync,
	entity: string,
	key: string,
	value: string,
	excludeFactId: string,
	scope?: string | null,
	scopeTarget?: string | null,
): MemoryEntry[] {
	const nowSec = Math.floor(Date.now() / 1000);
	const scopeClause = scope
		? scopeTarget != null
			? "AND scope = ? AND scope_target = ?"
			: "AND scope = ? AND scope_target IS NULL"
		: "";
	const baseParams: SQLInputValue[] = [
		entity,
		key,
		value,
		excludeFactId,
		nowSec,
	];
	const scopeParams: SQLInputValue[] = scope
		? scopeTarget != null
			? [scope, scopeTarget]
			: [scope]
		: [];
	const rows = db
		.prepare(
			`SELECT * FROM facts
         WHERE lower(entity) = lower(?)
           AND lower(key) = lower(?)
           AND lower(value) != lower(?)
           AND id != ?
           AND superseded_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           ${scopeClause}
         ORDER BY created_at DESC`,
		)
		.all(...baseParams, ...scopeParams) as Array<Record<string, unknown>>;
	return rows.map((r) => rowToMemoryEntry(r));
}

export function recordContradiction(
	db: DatabaseSync,
	factIdNew: string,
	factIdOld: string,
	createLink: (a: string, b: string, t: MemoryLinkType, s?: number) => string,
): string {
	const id = randomUUID();
	const detectedAt = new Date().toISOString();

	const tx = createTransaction(db, () => {
		const oldFactRow = db
			.prepare("SELECT confidence FROM facts WHERE id = ?")
			.get(factIdOld) as { confidence: number } | undefined;
		const originalConfidence = oldFactRow?.confidence ?? 1.0;

		db.prepare(
			`INSERT INTO contradictions (id, fact_id_new, fact_id_old, detected_at, resolved, resolution, old_fact_original_confidence)
           VALUES (?, ?, ?, ?, 0, NULL, ?)`,
		).run(id, factIdNew, factIdOld, detectedAt, originalConfidence);

		createLink(factIdNew, factIdOld, "CONTRADICTS", 1.0);

		updateConfidence(db, factIdOld, -0.2);
	});
	tx();
	return id;
}

export function detectContradictions(
	db: DatabaseSync,
	newFactId: string,
	entity: string | null | undefined,
	key: string | null | undefined,
	value: string | null | undefined,
	scope: string | null | undefined,
	scopeTarget: string | null | undefined,
	createLink: (a: string, b: string, t: MemoryLinkType, s?: number) => string,
): Array<{ contradictionId: string; oldFactId: string }> {
	if (!entity?.trim() || !key?.trim() || !value?.trim()) return [];

	const conflicting = findConflictingFacts(
		db,
		entity.trim(),
		key.trim(),
		value.trim(),
		newFactId,
		scope,
		scopeTarget,
	);
	const results: Array<{ contradictionId: string; oldFactId: string }> = [];

	for (const old of conflicting) {
		if (old.value?.toLowerCase() === value.trim().toLowerCase()) continue;
		const contradictionId = recordContradiction(
			db,
			newFactId,
			old.id,
			createLink,
		);
		results.push({ contradictionId, oldFactId: old.id });
	}

	return results;
}

export function getContradictions(
	db: DatabaseSync,
	factId?: string,
): ContradictionRecord[] {
	const rows = factId
		? (db
				.prepare(
					"SELECT * FROM contradictions WHERE fact_id_new = ? OR fact_id_old = ? ORDER BY detected_at DESC",
				)
				.all(factId, factId) as Array<Record<string, unknown>>)
		: (db
				.prepare(
					"SELECT * FROM contradictions WHERE resolved = 0 ORDER BY detected_at DESC",
				)
				.all() as Array<Record<string, unknown>>);
	return rows.map((r) => ({
		id: r.id as string,
		factIdNew: r.fact_id_new as string,
		factIdOld: r.fact_id_old as string,
		detectedAt: r.detected_at as string,
		resolved: (r.resolved as number) === 1,
		resolution:
			(r.resolution as "superseded" | "kept" | "merged" | null) ?? null,
		oldFactOriginalConfidence: r.old_fact_original_confidence as
			| number
			| undefined,
	}));
}

export function resolveContradiction(
	db: DatabaseSync,
	contradictionId: string,
	resolution: "superseded" | "kept" | "merged",
): boolean {
	const result = db
		.prepare(
			"UPDATE contradictions SET resolved = 1, resolution = ? WHERE id = ? AND resolved = 0",
		)
		.run(resolution, contradictionId);
	return result.changes > 0;
}

export function isContradicted(db: DatabaseSync, factId: string): boolean {
	const row = db
		.prepare(
			"SELECT 1 FROM contradictions WHERE (fact_id_old = ? OR fact_id_new = ?) AND resolved = 0 LIMIT 1",
		)
		.get(factId, factId);
	return row != null;
}

export function getContradictedIds(
	db: DatabaseSync,
	factIds: string[],
): Set<string> {
	if (factIds.length === 0) return new Set();
	const result = new Set<string>();
	const CHUNK = 499;
	for (let i = 0; i < factIds.length; i += CHUNK) {
		const chunk = factIds.slice(i, i + CHUNK);
		const placeholders = chunk.map(() => "?").join(",");
		const rows = db
			.prepare(
				`SELECT fact_id_old AS id FROM contradictions WHERE fact_id_old IN (${placeholders}) AND resolved = 0
           UNION
           SELECT fact_id_new AS id FROM contradictions WHERE fact_id_new IN (${placeholders}) AND resolved = 0`,
			)
			.all(...chunk, ...chunk) as Array<{ id: string }>;
		for (const r of rows) result.add(r.id);
	}
	return result;
}

export function resolveContradictionsAuto(
	db: DatabaseSync,
	getById: (id: string) => MemoryEntry | null,
	supersede: (oldId: string, newId: string | null) => boolean,
): {
	autoResolved: Array<{
		contradictionId: string;
		factIdNew: string;
		factIdOld: string;
	}>;
	ambiguous: Array<{
		contradictionId: string;
		factIdNew: string;
		factIdOld: string;
	}>;
} {
	const unresolved = getContradictions(db);
	const autoResolved: Array<{
		contradictionId: string;
		factIdNew: string;
		factIdOld: string;
	}> = [];
	const ambiguous: Array<{
		contradictionId: string;
		factIdNew: string;
		factIdOld: string;
	}> = [];

	for (const c of unresolved) {
		const newFact = getById(c.factIdNew);
		const oldFact = getById(c.factIdOld);

		if (!newFact && !oldFact) {
			resolveContradiction(db, c.id, "superseded");
			autoResolved.push({
				contradictionId: c.id,
				factIdNew: c.factIdNew,
				factIdOld: c.factIdOld,
			});
			continue;
		}

		if (!newFact && oldFact) {
			resolveContradiction(db, c.id, "kept");
			if (c.oldFactOriginalConfidence != null) {
				db.prepare("UPDATE facts SET confidence = ? WHERE id = ?").run(
					c.oldFactOriginalConfidence,
					c.factIdOld,
				);
			}
			autoResolved.push({
				contradictionId: c.id,
				factIdNew: c.factIdNew,
				factIdOld: c.factIdOld,
			});
			continue;
		}

		if (newFact && !oldFact) {
			resolveContradiction(db, c.id, "superseded");
			autoResolved.push({
				contradictionId: c.id,
				factIdNew: c.factIdNew,
				factIdOld: c.factIdOld,
			});
			continue;
		}

		const resolvedNew = newFact!;
		const resolvedOld = oldFact!;
		const newConf = resolvedNew.confidence ?? 1.0;
		const oldConf =
			c.oldFactOriginalConfidence ?? resolvedOld.confidence ?? 1.0;
		const newIsNewer = resolvedNew.createdAt >= resolvedOld.createdAt;
		const newIsHigherConf = newConf > oldConf;
		const newIsFromUser =
			resolvedNew.source === "conversation" || resolvedNew.source === "cli";

		if (newIsNewer && newIsHigherConf && newIsFromUser) {
			resolveContradiction(db, c.id, "superseded");
			supersede(c.factIdOld, c.factIdNew);
			autoResolved.push({
				contradictionId: c.id,
				factIdNew: c.factIdNew,
				factIdOld: c.factIdOld,
			});
		} else {
			ambiguous.push({
				contradictionId: c.id,
				factIdNew: c.factIdNew,
				factIdOld: c.factIdOld,
			});
		}
	}

	return { autoResolved, ambiguous };
}

export function contradictionsCount(db: DatabaseSync): number {
	try {
		const row = db
			.prepare("SELECT COUNT(*) as cnt FROM contradictions WHERE resolved = 0")
			.get() as {
			cnt: number;
		};
		return row?.cnt ?? 0;
	} catch (err) {
		capturePluginError(err as Error, {
			operation: "count-contradictions",
			severity: "info",
			subsystem: "facts",
		});
		return 0;
	}
}
