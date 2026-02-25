import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runContextAudit } from "../services/context-audit.js";
import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

describe("runContextAudit", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "context-audit-test-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    writeFileSync(join(tmpDir, "AGENTS.md"), "# Agents\nKeep it short.");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("summarizes workspace token usage", async () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass" },
    });
    const audit = await runContextAudit({ cfg, factsDb, workspaceRoot: tmpDir });

    expect(audit.workspaceFiles.totalTokens).toBeGreaterThan(0);
    expect(audit.workspaceFiles.files.some((f) => f.file === "AGENTS.md")).toBe(true);
    expect(audit.autoRecall.budgetTokens).toBe(cfg.autoRecall.maxTokens);
  });
});
