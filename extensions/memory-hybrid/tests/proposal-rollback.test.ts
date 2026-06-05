import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteProposalRollback,
  undoProposalRollback,
  writeProposalRollback,
} from "../services/proposal-rollback.js";

describe("proposal rollback undo", () => {
  let tmpDir: string;
  let sqlitePath: string;
  let targetPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-rollback-"));
    sqlitePath = join(tmpDir, "facts.db");
    targetPath = join(tmpDir, "SOUL.md");
    writeFileSync(targetPath, "# Original\n", "utf-8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("restores original content after apply when file matches appliedHash", () => {
    const original = readFileSync(targetPath, "utf-8");
    const applied = "# Original\n\nApplied guidance.\n";
    writeFileSync(targetPath, applied, "utf-8");
    writeProposalRollback(sqlitePath, {
      proposalId: "p1",
      proposalType: "persona",
      targetPath,
      originalHash: createHash("sha256").update(original).digest("hex"),
      originalContent: original,
      appliedHash: createHash("sha256").update(applied).digest("hex"),
      appliedAt: new Date().toISOString(),
    });
    const result = undoProposalRollback(sqlitePath, "p1");
    expect(result.ok).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe(original);
  });

  it("aborts undo when target changed after apply", () => {
    const original = readFileSync(targetPath, "utf-8");
    const applied = "# Original\n\nApplied guidance.\n";
    writeProposalRollback(sqlitePath, {
      proposalId: "p2",
      proposalType: "persona",
      targetPath,
      originalHash: createHash("sha256").update(original).digest("hex"),
      originalContent: original,
      appliedHash: createHash("sha256").update(applied).digest("hex"),
      appliedAt: new Date().toISOString(),
    });
    writeFileSync(targetPath, "# Manual edit\n", "utf-8");
    const result = undoProposalRollback(sqlitePath, "p2");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("changed since apply");
    expect(readFileSync(targetPath, "utf-8")).toBe("# Manual edit\n");
  });

  it("recreates missing target from rollback metadata", () => {
    const original = readFileSync(targetPath, "utf-8");
    const applied = "# Original\n\nApplied guidance.\n";
    writeProposalRollback(sqlitePath, {
      proposalId: "p3",
      proposalType: "persona",
      targetPath,
      originalHash: createHash("sha256").update(original).digest("hex"),
      originalContent: original,
      appliedHash: createHash("sha256").update(applied).digest("hex"),
      appliedAt: new Date().toISOString(),
    });
    rmSync(targetPath);
    const result = undoProposalRollback(sqlitePath, "p3");
    expect(result.ok).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe(original);
    deleteProposalRollback(sqlitePath, "p3");
  });
});
