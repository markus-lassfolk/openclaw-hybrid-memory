/**
 * cmd-verify fact count helpers (readApproxFactsRowCount, getCachedFactCount cache).
 * Requires Node >= 22.16 (node:sqlite).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { getCachedFactCount, readApproxFactsRowCount, resetVerifyFactCountCacheForTests } from "../cli/cmd-verify.js";

describe("cmd-verify fact count helpers", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let sqlitePath: string;

  beforeEach(() => {
    resetVerifyFactCountCacheForTests();
    tmpDir = mkdtempSync(join(tmpdir(), "cmd-verify-fact-count-"));
    sqlitePath = join(tmpDir, "facts.db");
    factsDb = new FactsDB(sqlitePath);
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("readApproxFactsRowCount returns null when sqlite_stat1 has no facts row", () => {
    const db = factsDb.getRawDb();
    const n = readApproxFactsRowCount(db);
    expect(n).toBeNull();
  });

  it("readApproxFactsRowCount parses first integer from sqlite_stat1 stat column", () => {
    factsDb.store({ text: "one", category: "fact", source: "test" });
    factsDb.store({ text: "two", category: "fact", source: "test" });
    factsDb.getRawDb().exec("ANALYZE");
    const n = readApproxFactsRowCount(factsDb.getRawDb());
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("getCachedFactCount reuses TTL cache for the same sqlite path", () => {
    factsDb.store({ text: "cached", category: "fact", source: "test" });
    const countSpy = vi.spyOn(factsDb, "count");
    const first = getCachedFactCount(factsDb, sqlitePath);
    const second = getCachedFactCount(factsDb, sqlitePath);
    expect(second).toBe(first);
    expect(countSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
