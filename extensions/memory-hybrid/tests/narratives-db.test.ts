import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NarrativesDB } from "../backends/narratives-db.js";

describe("NarrativesDB", () => {
	let dir: string;
	let db: NarrativesDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "narratives-db-"));
		db = new NarrativesDB(join(dir, "narratives.db"));
	});

	afterEach(() => {
		vi.useRealTimers();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("stores and lists recent session narratives", () => {
		db.store({
			sessionId: "s1",
			periodStart: 1000,
			periodEnd: 2000,
			tag: "session",
			narrativeText: "Context... Chronicle... Decisions...",
		});

		const rows = db.listRecent(5, "session");
		expect(rows.length).toBe(1);
		expect(rows[0].sessionId).toBe("s1");
		expect(rows[0].periodStart).toBe(1000);
	});

	it("keeps one narrative per session/tag (idempotent overwrite)", () => {
		const first = db.store({
			sessionId: "s1",
			periodStart: 1000,
			periodEnd: 2000,
			tag: "session",
			narrativeText: "First narrative",
		});
		const second = db.store({
			sessionId: "s1",
			periodStart: 2001,
			periodEnd: 3000,
			tag: "session",
			narrativeText: "Updated narrative",
		});

		const rows = db.listRecent(5, "session");
		expect(rows.length).toBe(1);
		expect(second.id).toBe(first.id);
		expect(rows[0].narrativeText).toBe("Updated narrative");
	});

	it("prunes narratives older than retention window", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
		db.store({
			sessionId: "old-session",
			periodStart: 1000,
			periodEnd: 2000,
			tag: "session",
			narrativeText: "Old",
		});
		vi.setSystemTime(new Date("2026-03-22T00:00:00.000Z"));
		db.store({
			sessionId: "new-session",
			periodStart: 3000,
			periodEnd: 4000,
			tag: "session",
			narrativeText: "New",
		});

		const pruned = db.pruneOlderThan(14);
		expect(pruned).toBe(1);
		const rows = db.listRecent(10, "all");
		expect(rows.map((r) => r.sessionId)).toEqual(["new-session"]);
	});

	it("reopens after close so listRecent still works", () => {
		db.store({
			sessionId: "s1",
			periodStart: 1000,
			periodEnd: 2000,
			tag: "session",
			narrativeText: "Stored before close",
		});

		db.close();

		const rows = db.listRecent(5, "session");
		expect(rows).toHaveLength(1);
		expect(rows[0].narrativeText).toBe("Stored before close");
	});

	it("lists narratives for one session across tags", () => {
		db.store({
			sessionId: "focus-session",
			periodStart: 1000,
			periodEnd: 2000,
			tag: "session",
			narrativeText: "Session summary",
		});
		db.store({
			sessionId: "focus-session",
			periodStart: 2001,
			periodEnd: 3000,
			tag: "weekly-rollup",
			narrativeText: "Weekly rollup",
		});
		db.store({
			sessionId: "other-session",
			periodStart: 3001,
			periodEnd: 4000,
			tag: "session",
			narrativeText: "Other",
		});

		const rows = db.listBySession("focus-session", 10, "all");
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.tag).sort()).toEqual([
			"session",
			"weekly-rollup",
		]);
	});
});
