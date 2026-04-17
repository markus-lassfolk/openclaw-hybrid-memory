/**
 * Read-only SQLite table dumps for `hybrid-mem dump` (debug / inspection).
 */

import type { DatabaseSync } from "node:sqlite";

/** User-facing type -> physical table */
const TYPE_TO_TABLE: Record<string, string> = {
	fact_entity: "fact_entity_mentions",
	fact_entities: "fact_entity_mentions",
	entity_mentions: "fact_entity_mentions",
	fact_entity_mentions: "fact_entity_mentions",
	fem: "fact_entity_mentions",
	org: "organizations",
	orgs: "organizations",
	organizations: "organizations",
	contact: "contacts",
	contacts: "contacts",
	org_fact_links: "org_fact_links",
	org_links: "org_fact_links",
	facts: "facts",
	links: "memory_links",
	memory_links: "memory_links",
	procedures: "procedures",
	contradictions: "contradictions",
	clusters: "clusters",
	cluster_members: "cluster_members",
	episodes: "episodes",
	episode_relations: "episode_relations",
	recall_log: "recall_log",
	implicit_signals: "implicit_signals",
	reinforcement_log: "reinforcement_log",
	scan_cursors: "scan_cursors",
	embedding_meta: "embedding_meta",
	feedback_trajectories: "feedback_trajectories",
	trajectories: "feedback_trajectories",
	feedback_effectiveness: "feedback_effectiveness",
};

const PREFERRED_ORDER: Record<string, string> = {
	fact_entity_mentions: "created_at",
	organizations: "updated_at",
	contacts: "updated_at",
	org_fact_links: "created_at",
	facts: "created_at",
	memory_links: "created_at",
	procedures: "updated_at",
	contradictions: "detected_at",
	clusters: "updated_at",
	cluster_members: "rowid",
	episodes: "created_at",
	episode_relations: "created_at",
	recall_log: "occurred_at",
	implicit_signals: "created_at",
	reinforcement_log: "occurred_at",
	scan_cursors: "last_run_at",
	embedding_meta: "updated_at",
	feedback_trajectories: "created_at",
	feedback_effectiveness: "measured_at",
};

const TRUNCATE_TEXT_TABLES = new Set(["facts", "procedures"]);

function assertSafeIdent(name: string): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		throw new Error(`Invalid SQL identifier: ${name}`);
	}
	return name;
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
	const safe = assertSafeIdent(table);
	const rows = db.prepare(`PRAGMA table_info(${safe})`).all() as Array<{
		name: string;
	}>;
	return new Set(rows.map((r) => r.name));
}

function resolveOrderColumn(db: DatabaseSync, table: string): string {
	const preferred = PREFERRED_ORDER[table] ?? "created_at";
	const cols = tableColumns(db, table);
	if (preferred === "rowid") return "rowid";
	if (cols.has(preferred)) return preferred;
	if (cols.has("created_at")) return "created_at";
	if (cols.has("updated_at")) return "updated_at";
	if (cols.has("occurred_at")) return "occurred_at";
	if (cols.has("timestamp")) return "timestamp";
	return "rowid";
}

export function resolveDumpTableType(type: string): string | null {
	const k = type.trim().toLowerCase().replace(/-/g, "_");
	return TYPE_TO_TABLE[k] ?? null;
}

export function listDumpTypeAliases(): string[] {
	const out = new Set<string>();
	for (const [alias, table] of Object.entries(TYPE_TO_TABLE)) {
		out.add(alias);
		out.add(table);
	}
	return [...out].sort((a, b) => a.localeCompare(b));
}

export type SqlDumpOrder = "first" | "last";

export type SqlDumpResult =
	| { ok: true; table: string; rows: Record<string, unknown>[] }
	| { ok: false; error: string };

function truncateValue(
	key: string,
	value: unknown,
	table: string,
	maxLen: number,
): unknown {
	if (typeof value !== "string") return value;
	if (!TRUNCATE_TEXT_TABLES.has(table)) return value;
	const textKeys =
		table === "facts"
			? ["text", "why", "key", "value"]
			: table === "procedures"
				? ["task_pattern", "recipe_json", "source_sessions"]
				: [];
	if (!textKeys.includes(key)) return value;
	if (value.length <= maxLen) return value;
	return `${value.slice(0, maxLen)}… (${value.length} chars)`;
}

export function runSqliteTableDump(
	db: DatabaseSync,
	opts: { type: string; limit: number; order: SqlDumpOrder; json: boolean },
): SqlDumpResult {
	const rawLimit = Number.isFinite(opts.limit) ? opts.limit : 20;
	const limit = Math.max(1, Math.min(5_000, Math.floor(rawLimit)));
	const table = resolveDumpTableType(opts.type);
	if (!table) {
		return {
			ok: false,
			error: `Unknown --type "${opts.type}". Use --list-types or see hybrid-mem dump --help.`,
		};
	}

	const exists = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table) as { 1?: number } | undefined;
	if (!exists) {
		return {
			ok: false,
			error: `Table "${table}" does not exist in this database (feature may be unused yet).`,
		};
	}

	const orderCol = resolveOrderColumn(db, table);
	const dir = opts.order === "last" ? "DESC" : "ASC";
	const qTable = assertSafeIdent(table);
	const qOrder = orderCol === "rowid" ? "rowid" : assertSafeIdent(orderCol);

	const rows = db
		.prepare(`SELECT * FROM ${qTable} ORDER BY ${qOrder} ${dir} LIMIT ?`)
		.all(limit) as Record<string, unknown>[];

	if (opts.json) {
		return { ok: true, table, rows };
	}

	const maxLen = 240;
	const display = rows.map((row) => {
		const o: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(row)) {
			o[k] = truncateValue(k, v, table, maxLen);
		}
		return o;
	});
	return { ok: true, table, rows: display };
}
