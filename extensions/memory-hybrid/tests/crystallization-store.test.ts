import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";

let tmpDir: string;
let cStore: CrystallizationStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "crystallization-store-test-"));
  cStore = new CrystallizationStore(join(tmpDir, "crystallization-proposals.db"));
});

afterEach(() => {
  cStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("CrystallizationStore.revertApproval", () => {
  it("rolls approved proposals back to validated and clears approved_at", () => {
    const p = cStore.create({
      patternId: "p-revert",
      evidenceHash: "ev-revert",
      skillName: "revert-skill",
      skillContent: "#c",
      patternSnapshot: "{}",
      status: "validated",
    });
    cStore.approve(p.id);
    expect(cStore.getById(p.id)?.status).toBe("approved");

    const reverted = cStore.revertApproval(p.id);
    expect(reverted?.status).toBe("validated");
    expect(reverted?.approvedAt).toBeUndefined();
  });

  it("returns null when proposal is not approved", () => {
    const p = cStore.create({
      patternId: "p-no-revert",
      evidenceHash: "ev-no-revert",
      skillName: "no-revert",
      skillContent: "#c",
      patternSnapshot: "{}",
    });
    expect(cStore.revertApproval(p.id)).toBeNull();
  });
});

describe("CrystallizationStore.pruneStalePendingProposals", () => {
  it("rejects drafted/validated proposals older than maxAgeDays", () => {
    const p = cStore.create({
      patternId: "p-stale",
      evidenceHash: "ev-stale",
      skillName: "stale-skill",
      skillContent: "#c",
      patternSnapshot: "{}",
      status: "validated",
    });
    const staleIso = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    (cStore as unknown as { liveDb: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).liveDb
      .prepare("UPDATE crystallization_proposals SET updated_at = ? WHERE id = ?")
      .run(staleIso, p.id);

    expect(cStore.pruneStalePendingProposals(30)).toBe(1);
    const updated = cStore.getById(p.id);
    expect(updated?.status).toBe("rejected");
    expect(updated?.rejectionReason).toContain("pruned: unused for 30 days");
  });

  it("returns 0 when maxAgeDays <= 0", () => {
    const p = cStore.create({
      patternId: "p-fresh",
      evidenceHash: "ev-fresh",
      skillName: "fresh-skill",
      skillContent: "#c",
      patternSnapshot: "{}",
    });
    expect(cStore.pruneStalePendingProposals(0)).toBe(0);
    expect(cStore.getById(p.id)?.status).toBe("drafted");
  });
});

describe("CrystallizationStore.list", () => {
  it("treats skillName LIKE wildcards as literal characters (#1454)", () => {
    cStore.create({
      patternId: "p-wildcard-percent",
      evidenceHash: "ev-wildcard-percent",
      skillName: "deploy%literal",
      skillContent: "#c",
      patternSnapshot: "{}",
    });
    cStore.create({
      patternId: "p-wildcard-underscore",
      evidenceHash: "ev-wildcard-underscore",
      skillName: "deploy_literal",
      skillContent: "#c",
      patternSnapshot: "{}",
    });
    cStore.create({
      patternId: "p-wildcard-backslash",
      evidenceHash: "ev-wildcard-backslash",
      skillName: "deploy\\literal",
      skillContent: "#c",
      patternSnapshot: "{}",
    });

    expect(cStore.list({ skillName: "%literal" }).map((p) => p.skillName)).toEqual(["deploy%literal"]);
    expect(cStore.list({ skillName: "_literal" }).map((p) => p.skillName)).toEqual(["deploy_literal"]);
    expect(cStore.list({ skillName: "\\literal" }).map((p) => p.skillName)).toEqual(["deploy\\literal"]);
  });
});
