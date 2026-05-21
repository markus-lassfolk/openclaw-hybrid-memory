import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";
import { runContextAudit } from "../services/context-audit.js";

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
      embedding: { provider: "openai", apiKey: "sk-test-key-that-is-long-enough-to-pass" },
    });
    const audit = await runContextAudit({ cfg, factsDb, workspaceRoot: tmpDir });

    expect(audit.workspaceFiles.totalTokens).toBeGreaterThan(0);
    expect(audit.workspaceFiles.files.some((f) => f.file === "AGENTS.md")).toBe(true);
    expect(audit.autoRecall.budgetTokens).toBe(cfg.autoRecall.maxTokens);
  });

  it("keeps activeTasks.count as a backwards-compatible injected-task alias", async () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai", apiKey: "sk-test-key-that-is-long-enough-to-pass" },
      activeTask: { enabled: true, ledger: "facts", injectionBudget: 1000, projection: { excludeGenericTitle: false } },
    });
    factsDb.store(
      {
        category: "project",
        entity: "context-audit-alias",
        key: "status",
        value: "in_progress",
        text: "context audit alias status in progress",
        // Must use source:"active-task" so loadTaskLedgerFromFacts picks it up (fix #1556).
        source: "active-task",
        importance: 0.5,
        decayClass: "permanent",
      },
      { suppressVectorFallbackWarning: true },
    );

    const audit = await runContextAudit({ cfg, factsDb, workspaceRoot: tmpDir });

    expect(audit.activeTasks.injectedTaskCount).toBeGreaterThan(0);
    expect(audit.activeTasks.count).toBe(audit.activeTasks.ledgerActiveCount);
    expect(audit.activeTasks.injectedCount).toBe(audit.activeTasks.injectedTaskCount);
  });
});
