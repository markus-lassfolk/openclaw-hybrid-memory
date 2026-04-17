/**
 * Episodic memory: episodes table + FTS (#781) (Issue #954 split).
 */
import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

import type { DecayClass } from "../../config.js";
import type {
	Episode,
	EpisodeOutcome,
	ScopeFilter,
} from "../../types/memory.js";
import { createTransaction } from "../../utils/sqlite-transaction.js";
import { parseTags, serializeTags } from "../../utils/tags.js";
import { sanitizeFts5QueryForFacts } from "./fts-text.js";
import { scopeFilterClausePositional } from "./scope-sql.js";

export function rowToEpisode(row: Record<string, unknown>): Episode {
	const relatedFactIdsRaw = row.related_fact_ids as string | null;
	return {
		id: row.id as string,
		category: "episode",
		event: row.event as string,
		outcome: row.outcome as EpisodeOutcome,
		timestamp: row.timestamp as number,
		duration: (row.duration as number) ?? undefined,
		context: (row.context as string) ?? undefined,
		relatedFactIds: relatedFactIdsRaw
			? (JSON.parse(relatedFactIdsRaw) as string[])
			: undefined,
		procedureId: (row.procedure_id as string) ?? undefined,
		scope: (row.scope as "global" | "user" | "agent" | "session") ?? "global",
		scopeTarget: (row.scope_target as string) ?? undefined,
		agentId: (row.agent_id as string) ?? undefined,
		userId: (row.user_id as string) ?? undefined,
		sessionId: (row.session_id as string) ?? undefined,
		importance: row.importance as number,
		tags: parseTags(row.tags as string | null),
		decayClass: (row.decay_class as DecayClass) ?? "normal",
		createdAt: row.created_at as number,
		verifiedAt: (row.verified_at as number) ?? undefined,
	};
}

export function recordEpisode(
	db: DatabaseSync,
	input: {
		event: string;
		outcome: EpisodeOutcome;
		timestamp?: number;
		duration?: number;
		context?: string;
		relatedFactIds?: string[];
		procedureId?: string;
		importance?: number;
		tags?: string[];
		decayClass?: DecayClass;
		scope?: "global" | "user" | "agent" | "session";
		scopeTarget?: string | null;
		agentId?: string;
		userId?: string;
		sessionId?: string;
	},
): Episode {
	const id = randomUUID();
	const nowSec = Math.floor(Date.now() / 1000);
	const timestamp = input.timestamp ?? nowSec;

	let importance = input.importance ?? 0.5;
	if (input.outcome === "failure" && importance < 0.8) {
		importance = 0.8;
	}

	const decayClass = input.decayClass ?? "normal";
	const scope = input.scope ?? "global";
	const scopeTarget = scope === "global" ? null : (input.scopeTarget ?? null);
	const tags = input.tags ?? [];
	const relatedFactIds = input.relatedFactIds ?? [];

	const tx = createTransaction(db, () => {
		db.prepare(
			`INSERT INTO episodes (id, event, outcome, timestamp, duration, context, related_fact_ids, procedure_id, scope, scope_target, agent_id, user_id, session_id, importance, tags, decay_class, created_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			input.event,
			input.outcome,
			timestamp,
			input.duration ?? null,
			input.context ?? null,
			relatedFactIds.length > 0 ? JSON.stringify(relatedFactIds) : null,
			input.procedureId ?? null,
			scope,
			scopeTarget,
			input.agentId ?? null,
			input.userId ?? null,
			input.sessionId ?? null,
			importance,
			serializeTags(tags),
			decayClass,
			nowSec,
			null,
		);

		for (const factId of relatedFactIds) {
			db.prepare(
				"INSERT INTO episode_relations (id, episode_id, target_id, relation_type, strength, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			).run(randomUUID(), id, factId, "PART_OF", 0.8, nowSec);
		}
	});
	tx();

	return {
		id,
		category: "episode",
		event: input.event,
		outcome: input.outcome,
		timestamp,
		duration: input.duration,
		context: input.context,
		relatedFactIds,
		procedureId: input.procedureId,
		scope,
		scopeTarget: scopeTarget ?? undefined,
		agentId: input.agentId,
		userId: input.userId,
		sessionId: input.sessionId,
		importance,
		tags,
		decayClass,
		createdAt: nowSec,
	};
}

export function searchEpisodes(
	db: DatabaseSync,
	options: {
		query?: string;
		outcome?: EpisodeOutcome[];
		since?: number;
		until?: number;
		procedureId?: string;
		limit?: number;
		scopeFilter?: ScopeFilter | null;
	} = {},
): Episode[] {
	const {
		query,
		outcome,
		since,
		until,
		procedureId,
		limit = 50,
		scopeFilter,
	} = options;
	const params: unknown[] = [];
	const conditions: string[] = [];

	if (query?.trim()) {
		const sanitized = sanitizeFts5QueryForFacts(query.trim());
		const words = sanitized
			.split(/\s+/)
			.filter((w) => w.length > 1)
			.slice(0, 8)
			.map((w) => `"${w}"`)
			.join(" OR ");
		if (words) {
			conditions.push(
				"e.rowid IN (SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH ?)",
			);
			params.push(words);
		}
	}

	if (outcome && outcome.length > 0) {
		const placeholders = outcome.map(() => "?").join(",");
		conditions.push(`e.outcome IN (${placeholders})`);
		params.push(...outcome);
	}

	if (since !== undefined) {
		conditions.push("e.timestamp >= ?");
		params.push(since);
	}
	if (until !== undefined) {
		conditions.push("e.timestamp <= ?");
		params.push(until);
	}

	if (procedureId) {
		conditions.push("e.procedure_id = ?");
		params.push(procedureId);
	}

	const scopeClause = scopeFilterClausePositional(scopeFilter);
	if (scopeClause.clause) {
		conditions.push(scopeClause.clause.replace(/^AND /, ""));
		params.push(...scopeClause.params);
	}

	const where =
		conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limitClause = "ORDER BY e.timestamp DESC LIMIT ?";
	params.push(limit);

	const sql = `SELECT e.* FROM episodes e ${where} ${limitClause}`;
	const rows = db.prepare(sql).all(...(params as SQLInputValue[])) as Array<
		Record<string, unknown>
	>;
	return rows.map((r) => rowToEpisode(r));
}

export function getEpisode(db: DatabaseSync, id: string): Episode | null {
	const row = db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as
		| Record<string, unknown>
		| undefined;
	if (!row) return null;
	return rowToEpisode(row);
}

export function deleteEpisode(db: DatabaseSync, id: string): boolean {
	const result = db.prepare("DELETE FROM episodes WHERE id = ?").run(id);
	return result.changes > 0;
}

export function episodesCount(db: DatabaseSync): number {
	try {
		const row = db.prepare("SELECT COUNT(*) as cnt FROM episodes").get() as {
			cnt: number;
		};
		return row?.cnt ?? 0;
	} catch {
		return 0;
	}
}
