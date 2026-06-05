import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isIsoUtcTimestamp } from "../utils/dates.js";
import { backfillTextTimestampColumn } from "../utils/timestamp-migration.js";

describe("timestamp migration backfill", () => {
  let tmpDir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmpDir = join(process.cwd(), `.test-timestamp-mig-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    db = new DatabaseSync(join(tmpDir, "test.db"));
    db.exec(`
      CREATE TABLE sample (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("converts SQLite space datetime to ISO Z", () => {
    db.prepare("INSERT INTO sample (id, created_at) VALUES (?, ?)").run("a", "2026-06-05 12:34:56");
    backfillTextTimestampColumn(db, "sample", "created_at");
    const row = db.prepare("SELECT created_at FROM sample WHERE id = 'a'").get() as { created_at: string };
    expect(row.created_at).toBe("2026-06-05T12:34:56Z");
    expect(isIsoUtcTimestamp(row.created_at)).toBe(true);
  });

  it("converts numeric epoch string to ISO Z", () => {
    db.prepare("INSERT INTO sample (id, created_at) VALUES (?, ?)").run("b", "1700000000");
    backfillTextTimestampColumn(db, "sample", "created_at");
    const row = db.prepare("SELECT created_at FROM sample WHERE id = 'b'").get() as { created_at: string };
    expect(row.created_at).toMatch(/^2023-11-14T22:13:20\.\d{3}Z$/);
  });

  it("is idempotent for already-ISO rows", () => {
    const iso = "2026-06-05T12:34:56.789Z";
    db.prepare("INSERT INTO sample (id, created_at) VALUES (?, ?)").run("c", iso);
    backfillTextTimestampColumn(db, "sample", "created_at");
    const row = db.prepare("SELECT created_at FROM sample WHERE id = 'c'").get() as { created_at: string };
    expect(row.created_at).toBe(iso);
  });

  it("converts timezone-less ISO to ISO Z", () => {
    db.prepare("INSERT INTO sample (id, created_at) VALUES (?, ?)").run("d", "2026-06-05T12:34:56");
    backfillTextTimestampColumn(db, "sample", "created_at");
    const row = db.prepare("SELECT created_at FROM sample WHERE id = 'd'").get() as { created_at: string };
    expect(row.created_at).toBe("2026-06-05T12:34:56.000Z");
  });

  it("converts ISO offset to canonical ISO Z", () => {
    db.prepare("INSERT INTO sample (id, created_at) VALUES (?, ?)").run("g", "2026-06-05T12:34:56+00:00");
    backfillTextTimestampColumn(db, "sample", "created_at");
    const row = db.prepare("SELECT created_at FROM sample WHERE id = 'g'").get() as { created_at: string };
    expect(row.created_at).toBe("2026-06-05T12:34:56.000Z");
  });

  it("skips backfill when all rows are already ISO Z", () => {
    db.prepare("INSERT INTO sample (id, created_at) VALUES (?, ?)").run("e", "2026-06-05T12:34:56.789Z");
    db.prepare("INSERT INTO sample (id, created_at) VALUES (?, ?)").run("f", "2026-06-06T08:00:00.000Z");
    backfillTextTimestampColumn(db, "sample", "created_at");
    expect(
      (db.prepare("SELECT created_at FROM sample WHERE id = 'e'").get() as { created_at: string }).created_at,
    ).toBe("2026-06-05T12:34:56.789Z");
  });
});
