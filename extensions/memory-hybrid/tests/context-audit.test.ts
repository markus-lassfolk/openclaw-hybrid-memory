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
    expect(audit.autoRecall.fixedBlocks.caps.hotMaxTokens).toBeGreaterThanOrEqual(0);
    expect(audit.autoRecall.fixedBlocks.estimatedTokens.remainingForRecall).toBeGreaterThanOrEqual(0);
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

  it("reports zero fixed-block caps when autoRecall is disabled", async () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai", apiKey: "sk-test-key-that-is-long-enough-to-pass" },
      autoRecall: { enabled: false },
      activeTask: { enabled: true, injectionBudget: 1000, staleWarning: { enabled: true } },
    });

    const audit = await runContextAudit({ cfg, factsDb, workspaceRoot: tmpDir });

    expect(audit.autoRecall.budgetTokens).toBe(0);
    expect(audit.autoRecall.fixedBlocks.caps).toEqual({
      issueMaxTokens: 0,
      narrativeMaxTokens: 0,
      hotMaxTokens: 0,
      procedureMaxTokens: 0,
      activeTaskMaxTokens: 0,
      staleWarningMaxTokens: 0,
    });
    expect(audit.autoRecall.fixedBlocks.estimatedTokens.total).toBe(0);
    expect(audit.autoRecall.fixedBlocks.estimatedTokens.remainingForRecall).toBe(0);
  });

  it("sanitizes HOT reasoning traces before estimating fixed-block tokens", async () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai", apiKey: "sk-test-key-that-is-long-enough-to-pass" },
      memoryTiering: { enabled: true, hotMaxTokens: 2000 },
      autoRecall: { enabled: true, maxTokens: 400, hotMaxTokens: 200, narrativeMaxTokens: 0 },
    });
    factsDb.getHotFacts = (() => [
      {
        entry: {
          id: "context-audit-hot-sanitize",
          category: "fact",
          entity: "context-audit-hot-sanitize",
          key: "note",
          value: "visible",
          text: `<think>${"x".repeat(1600)}</think> visible memory`,
          summary: null,
          source: "test",
          tags: [],
          importance: 0.95,
          decayClass: "normal",
          recallCount: 0,
          lastConfirmedAt: 0,
          confidence: 1,
          createdAt: 1,
          expiresAt: null,
          validFrom: 0,
          validUntil: null,
          supersededBy: null,
          scope: "global",
        },
        score: 1,
        backend: "sqlite",
      },
    ]) as typeof factsDb.getHotFacts;

    const audit = await runContextAudit({ cfg, factsDb, workspaceRoot: tmpDir });

    expect(audit.autoRecall.hotTokens).toBeGreaterThan(0);
    expect(audit.autoRecall.hotTokens).toBeLessThan(80);
    expect(audit.autoRecall.fixedBlocks.estimatedTokens.hot).toBe(audit.autoRecall.hotTokens);
  });

  it("excludes another tenant's procedures from the audit when a scopeFilter is passed (#2067-followup)", async () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai", apiKey: "sk-test-key-that-is-long-enough-to-pass" },
      procedures: { enabled: true, validationThreshold: 1 },
    });
    factsDb.upsertProcedure({
      taskPattern: "Deploy tenant-a's release pipeline",
      recipeJson: JSON.stringify([{ tool: "exec", args: { command: "deploy" } }]),
      procedureType: "positive",
      confidence: 0.9,
      scope: "user",
      scopeTarget: "tenant-a",
    });

    // Without a scopeFilter, every tenant's procedures are visible (existing/global-audit behavior).
    const unscoped = await runContextAudit({ cfg, factsDb, workspaceRoot: tmpDir });
    expect(unscoped.procedures.lines).toBeGreaterThan(0);

    // A caller scoped to a different tenant must not see tenant-a's procedure in its budget report.
    const scoped = await runContextAudit({
      cfg,
      factsDb,
      workspaceRoot: tmpDir,
      scopeFilter: { userId: "tenant-b" },
    });
    expect(scoped.procedures.lines).toBe(0);
    expect(scoped.procedures.tokens).toBe(0);
  });
});
