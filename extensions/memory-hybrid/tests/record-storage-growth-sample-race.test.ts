/**
 * recordStorageGrowthSample()'s same-day guard must be a single atomic SQL statement, not a
 * separate SELECT-then-INSERT pair — otherwise two processes racing near-simultaneously (a cron
 * audit-health run overlapping a manual `storage sample`) can both pass the "not yet sampled
 * today" check and each insert a row, duplicating the day and skewing 7d growth deltas.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordStorageGrowthSample } from "../cli/commands/manage/storage-stats-helpers.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

describe("recordStorageGrowthSample same-day guard", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  afterEach(() => {
    factsDb?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("performs the not-yet-sampled-today check and the insert as a single SQL round trip", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-storage-growth-race-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    const raw = factsDb.getRawDb();
    const prepareSpy = vi.spyOn(raw, "prepare");

    const result = recordStorageGrowthSample(factsDb as never, 1000, {});

    expect(result.inserted).toBe(true);
    // Exactly one prepare() call for the guarded write itself (an earlier COUNT for link_count
    // happens before this point) — not a separate SELECT-then-INSERT pair with a gap between
    // them for another connection to race into.
    const guardCalls = prepareSpy.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("storage_growth_history"),
    );
    expect(guardCalls).toHaveLength(1);
    expect(String(guardCalls[0]?.[0])).toMatch(/^INSERT INTO storage_growth_history/);
  });

  it("still dedupes same-day samples across two separate connections to the same file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-storage-growth-race-multi-"));
    const dbPath = join(tmpDir, "facts.db");
    const db1 = new FactsDB(dbPath);
    const first = recordStorageGrowthSample(db1 as never, 1000, {});
    db1.close();

    factsDb = new FactsDB(dbPath);
    const second = recordStorageGrowthSample(factsDb as never, 2000, {});

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.reason).toBe("already_sampled_today");
    const rows = factsDb
      .getRawDb()
      .prepare("SELECT COUNT(*) AS c FROM storage_growth_history")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });
});
