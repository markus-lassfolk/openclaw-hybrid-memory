import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
	listDumpTypeAliases,
	resolveDumpTableType,
	runSqliteTableDump,
} from "../services/cli-sql-dump.js";

describe("cli-sql-dump", () => {
	it("resolves fact_entity alias", () => {
		expect(resolveDumpTableType("fact_entity")).toBe("fact_entity_mentions");
		expect(resolveDumpTableType("FACT-ENTITY")).toBe("fact_entity_mentions");
	});

	it("listDumpTypeAliases is sorted and includes core names", () => {
		const list = listDumpTypeAliases();
		expect(list).toContain("fact_entity");
		expect(list).toContain("fact_entity_mentions");
		expect(list).toEqual([...list].sort((a, b) => a.localeCompare(b)));
	});

	it("runSqliteTableDump reads rows with order last", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`
      CREATE TABLE fact_entity_mentions (
        id TEXT PRIMARY KEY,
        fact_id TEXT NOT NULL,
        label TEXT NOT NULL,
        surface_text TEXT NOT NULL,
        normalized_surface TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        confidence REAL NOT NULL,
        detected_lang TEXT,
        source TEXT NOT NULL,
        contact_id TEXT,
        organization_id TEXT,
        created_at INTEGER NOT NULL
      )
    `);
		db.prepare(
			`INSERT INTO fact_entity_mentions (
        id, fact_id, label, surface_text, normalized_surface,
        start_offset, end_offset, confidence, detected_lang, source, created_at
      ) VALUES (?, ?, ?, ?, ?, 0, 1, 0.8, 'eng', 'llm', ?)`,
		).run("a", "f1", "PERSON", "Ada", "ada", 100);
		db.prepare(
			`INSERT INTO fact_entity_mentions (
        id, fact_id, label, surface_text, normalized_surface,
        start_offset, end_offset, confidence, detected_lang, source, created_at
      ) VALUES (?, ?, ?, ?, ?, 0, 1, 0.8, 'eng', 'llm', ?)`,
		).run("b", "f1", "ORG", "ACME", "acme", 200);

		const last = runSqliteTableDump(db, {
			type: "fact_entity",
			limit: 10,
			order: "last",
			json: true,
		});
		expect(last.ok).toBe(true);
		if (last.ok) {
			expect(last.rows).toHaveLength(2);
			expect((last.rows[0] as { surface_text: string }).surface_text).toBe(
				"ACME",
			);
		}

		const first = runSqliteTableDump(db, {
			type: "fact_entity",
			limit: 1,
			order: "first",
			json: true,
		});
		expect(first.ok).toBe(true);
		if (first.ok) {
			expect(first.rows).toHaveLength(1);
			expect((first.rows[0] as { surface_text: string }).surface_text).toBe(
				"Ada",
			);
		}
	});

	it("runSqliteTableDump errors on unknown type", () => {
		const db = new DatabaseSync(":memory:");
		const r = runSqliteTableDump(db, {
			type: "nope",
			limit: 5,
			order: "last",
			json: true,
		});
		expect(r.ok).toBe(false);
	});

	it("runSqliteTableDump errors when table missing", () => {
		const db = new DatabaseSync(":memory:");
		const r = runSqliteTableDump(db, {
			type: "organizations",
			limit: 5,
			order: "last",
			json: true,
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/does not exist/);
	});
});
