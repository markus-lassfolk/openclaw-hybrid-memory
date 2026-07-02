/**
 * A failure inside the entityEnrichmentBacklog section of buildAuditHealthReport must surface in
 * report.errors (and therefore report.errorCount), not be silently swallowed — otherwise
 * `audit health --strict-errors` sees a clean report even though a section failed to run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuditHealthReport } from "../cli/commands/manage/storage-stats-helpers.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

describe("buildAuditHealthReport entityEnrichmentBacklog error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a report error instead of silently swallowing a backlog query failure", () => {
    const db = new FactsDB(":memory:");
    vi.spyOn(db, "getEntityEnrichmentBacklogSummary").mockImplementation(() => {
      throw new Error("backlog query boom");
    });

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500);

    expect(report.entityEnrichmentBacklog).toBeNull();
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.errors.some((e) => e.section === "entityEnrichmentBacklog" && e.message.includes("backlog query boom"))).toBe(
      true,
    );

    db.close();
  });
});
