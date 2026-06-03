/**
 * Tests for generate-proposals requireScopeFilter behaviour (#1809).
 *
 * Verifies that:
 * - requireScopeFilter=false (default): warning logged, job continues
 * - requireScopeFilter=true: throws when scopeFilter absent and non-global scoped facts exist
 * - requireScopeFilter=true: does not throw when all facts are global scope
 * - audit-health: preReportWarnings surfaces scopeFilter absence
 */
import { describe, expect, it, vi } from "vitest";

import { runGenerateProposalsForCli } from "../cli/cmd-extract-proposals.js";
import { buildAuditHealthReport } from "../cli/commands/manage/register-storage-and-stats.js";
import type { HandlerContext } from "../cli/handlers.js";
import type { HybridMemoryConfig } from "../config/types/index.js";
import { _testing } from "../index.js";
import * as chatService from "../services/chat.js";

const { FactsDB, ProposalsDB } = _testing;

/** Insert a pattern fact with a specific scope into the given db. */
function insertScopedPattern(
  db: InstanceType<typeof FactsDB>,
  scope: "global" | "agent" | "user" | "session",
  scopeTarget: string | null,
  text: string,
): void {
  db.store({
    text,
    category: "pattern",
    importance: 0.5,
    entity: null,
    key: null,
    value: null,
    source: "test",
    scope,
    scopeTarget: scope === "global" ? null : scopeTarget,
  });
}

/** Minimal HandlerContext for generate-proposals tests. */
function makeCtx(
  db: InstanceType<typeof FactsDB>,
  proposalsDb: InstanceType<typeof ProposalsDB>,
  overrides: {
    requireScopeFilter?: boolean;
    scopeFilter?: { userId?: string; agentId?: string; sessionId?: string };
    configOverrides?: Partial<HybridMemoryConfig>;
  } = {},
): HandlerContext {
  const cfg = {
    personaProposals: {
      enabled: true,
      autoApply: false,
      allowedFiles: ["SOUL.md", "IDENTITY.md", "USER.md"],
      maxProposalsPerWeek: 5,
      minConfidence: 0.7,
      proposalTTLDays: 30,
      minSessionEvidence: 10,
      requireScopeFilter: overrides.requireScopeFilter ?? false,
    },
    autoRecall: {
      scopeFilter: overrides.scopeFilter ?? undefined,
    },
    identityReflection: { enabled: false },
    identityPromotion: { enabled: false },
    ...overrides.configOverrides,
  } as unknown as HybridMemoryConfig;

  return {
    factsDb: db,
    proposalsDb,
    cfg,
    openai: null,
    personaStateStore: null,
    identityReflectionStore: null,
    logger: { warn: vi.fn(), info: vi.fn() },
  } as unknown as HandlerContext;
}

describe("generate-proposals — requireScopeFilter (#1809)", () => {
  it("logs a warning (does not throw) when requireScopeFilter=false and non-global scoped facts exist", async () => {
    const db = new FactsDB(":memory:");
    const proposalsDb = new ProposalsDB(":memory:");
    insertScopedPattern(db, "agent", "agent1", "test agent pattern");

    const ctx = makeCtx(db, proposalsDb, { requireScopeFilter: false });
    const warnSpy = vi.spyOn(ctx.logger, "warn");

    // insights.length = 1 (one pattern) → passes scopeFilter check, hits LLM (openai=null) → throws.
    // We only care that the warn was called before any LLM call.
    let caughtError: Error | null = null;
    await runGenerateProposalsForCli(ctx, { dryRun: false }, { resolvePath: (f) => f }).catch((err: Error) => {
      caughtError = err;
    });
    // If an error was caught it must be the LLM failure, not the scopeFilter contamination error.
    if (caughtError !== null) {
      expect((caughtError as Error).message).not.toContain("autoRecall.scopeFilter is not set");
    }

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("autoRecall.scopeFilter is not set"));
  });

  it("throws when requireScopeFilter=true, scopeFilter absent, and non-global scoped facts exist", async () => {
    const db = new FactsDB(":memory:");
    const proposalsDb = new ProposalsDB(":memory:");
    insertScopedPattern(db, "agent", "agent1", "test agent pattern");

    const ctx = makeCtx(db, proposalsDb, { requireScopeFilter: true });

    await expect(runGenerateProposalsForCli(ctx, { dryRun: false }, { resolvePath: (f) => f })).rejects.toThrow(
      "autoRecall.scopeFilter is not set",
    );
  });

  it("does not throw when requireScopeFilter=true but all facts are global scope", async () => {
    const db = new FactsDB(":memory:");
    const proposalsDb = new ProposalsDB(":memory:");
    insertScopedPattern(db, "global", null, "global pattern");

    const ctx = makeCtx(db, proposalsDb, { requireScopeFilter: true });
    // No non-global scoped facts → no contamination risk → no scope-filter throw.
    // insights block has content; openai=null → will throw on LLM call, but that's after the scopeFilter check.
    let thrownError: Error | null = null;
    try {
      await runGenerateProposalsForCli(ctx, { dryRun: false }, { resolvePath: (f) => f });
    } catch (err: unknown) {
      thrownError = err as Error;
    }
    // If an error was thrown (expected: LLM failure), it must not be the scopeFilter contamination error.
    if (thrownError !== null) {
      expect(thrownError.message).not.toContain("autoRecall.scopeFilter is not set");
    }
  });

  it("does not throw scopeFilter error when requireScopeFilter=true and scopeFilter is set", async () => {
    const db = new FactsDB(":memory:");
    const proposalsDb = new ProposalsDB(":memory:");
    insertScopedPattern(db, "agent", "agent1", "test agent pattern");

    const ctx = makeCtx(db, proposalsDb, {
      requireScopeFilter: true,
      scopeFilter: { agentId: "agent1" },
    });
    // scopeFilter is set → hasScopeFilter=true → no scope-filter check fires.
    // The fact matches the agentId filter so insights are non-empty; LLM (openai=null) throws,
    // but that error must not be the scopeFilter contamination error.
    let thrownError: Error | null = null;
    try {
      await runGenerateProposalsForCli(ctx, { dryRun: false }, { resolvePath: (f) => f });
    } catch (err: unknown) {
      thrownError = err as Error;
    }
    // If an error was thrown (expected: LLM failure), it must not be the scopeFilter contamination error.
    if (thrownError !== null) {
      expect(thrownError.message).not.toContain("autoRecall.scopeFilter is not set");
    }
  });

  it("includes llm.fallbackModel for maintenance generate-proposals fallback chain", async () => {
    const db = new FactsDB(":memory:");
    const proposalsDb = new ProposalsDB(":memory:");
    insertScopedPattern(db, "global", null, "global pattern");
    const chatSpy = vi.spyOn(chatService, "chatCompleteWithRetryDetailed").mockRejectedValue(new Error("forced failure"));

    const ctx = makeCtx(db, proposalsDb, {
      configOverrides: {
        llm: {
          maintenance: ["minimax/minimax-m1"],
          default: ["openai/gpt-4.1-mini"],
          heavy: ["openai/gpt-5.4"],
          fallbackModel: "openai/gpt-4.1-mini",
        },
      },
    });

    try {
      await expect(runGenerateProposalsForCli(ctx, { dryRun: false }, { resolvePath: (f) => f })).rejects.toThrow(
        /models tried:.*openai\/gpt-4\.1-mini/,
      );
    } finally {
      chatSpy.mockRestore();
    }
  });

  it("#1824: uses maintenance safety-net fallback when single maintenance model has no configured fallbacks", async () => {
    const db = new FactsDB(":memory:");
    const proposalsDb = new ProposalsDB(":memory:");
    insertScopedPattern(db, "global", null, "global pattern");
    const chatSpy = vi.spyOn(chatService, "chatCompleteWithRetryDetailed").mockRejectedValue(new Error("forced failure"));

    const ctx = makeCtx(db, proposalsDb, {
      configOverrides: {
        llm: {
          maintenance: ["minimax/MiniMax-M2.7-highspeed"],
          default: ["minimax/MiniMax-M2.7-highspeed", "openai/gpt-4.1-mini"],
          heavy: ["openai/gpt-5.4"],
        },
      },
    });

    try {
      await expect(runGenerateProposalsForCli(ctx, { dryRun: false }, { resolvePath: (f) => f })).rejects.toThrow(
        /models tried:.*openai\/gpt-4\.1-mini/,
      );
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("generate-proposals fallback chain = [openai/gpt-4.1-mini]"),
      );
    } finally {
      chatSpy.mockRestore();
    }
  });
});

describe("generate-proposals — JSON retry (#1824)", () => {
  function makeCtxWithMaintenanceFallbackModels(
    db: InstanceType<typeof FactsDB>,
    proposalsDb: InstanceType<typeof ProposalsDB>,
    openai: unknown,
  ): HandlerContext {
    const cfg = {
      personaProposals: {
        enabled: true,
        autoApply: false,
        allowedFiles: ["SOUL.md"],
        maxProposalsPerWeek: 5,
        minConfidence: 0.5,
        proposalTTLDays: 30,
        minSessionEvidence: 1,
        requireScopeFilter: false,
      },
      autoRecall: { scopeFilter: undefined },
      identityReflection: { enabled: false },
      identityPromotion: { enabled: false },
      llm: {
        maintenance: ["primary-model"],
        default: ["primary-model", "fallback-model"],
        heavy: ["openai/gpt-5.4"],
      },
    } as unknown as HybridMemoryConfig;

    return {
      factsDb: db,
      proposalsDb,
      cfg,
      openai,
      personaStateStore: null,
      identityReflectionStore: null,
      logger: { warn: vi.fn(), info: vi.fn() },
    } as unknown as HandlerContext;
  }

  it("retries with fallback model when primary returns invalid JSON", async () => {
    const db = new FactsDB(":memory:");
    const proposalsDb = new ProposalsDB(":memory:");
    insertScopedPattern(db, "global", null, "User consistently prefers functional composition over OOP patterns");
    insertScopedPattern(
      db,
      "global",
      null,
      "User values type safety and enables TypeScript strict mode in all projects",
    );

    let callIndex = 0;
    const validJson = JSON.stringify([
      {
        targetFile: "SOUL.md",
        title: "Test proposal",
        observation: "Observed pattern",
        suggestedChange: "Add note about TypeScript preference",
        confidence: 0.8,
      },
    ]);
    const openai = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: callIndex++ === 0 ? "not json at all!!!" : validJson } }],
          })),
        },
      },
    };

    const ctx = makeCtxWithMaintenanceFallbackModels(db, proposalsDb, openai);
    const result = await runGenerateProposalsForCli(ctx, { dryRun: false }, { resolvePath: (f) => f });

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(1);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("invalid JSON"));
  });

  it("throws when all models return invalid JSON", async () => {
    const db = new FactsDB(":memory:");
    const proposalsDb = new ProposalsDB(":memory:");
    insertScopedPattern(db, "global", null, "User consistently prefers functional composition over OOP patterns");
    insertScopedPattern(
      db,
      "global",
      null,
      "User values type safety and enables TypeScript strict mode in all projects",
    );

    const openai = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: "not valid json" } }],
          })),
        },
      },
    };

    const ctx = makeCtxWithMaintenanceFallbackModels(db, proposalsDb, openai);

    await expect(runGenerateProposalsForCli(ctx, { dryRun: false }, { resolvePath: (f) => f })).rejects.toThrow(
      "all models failed",
    );

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("does not leak raw LLM response snippets in thrown/default error when verbose=false", async () => {
    const db = new FactsDB(":memory:");
    const proposalsDb = new ProposalsDB(":memory:");
    insertScopedPattern(db, "global", null, "User consistently prefers functional composition over OOP patterns");
    insertScopedPattern(
      db,
      "global",
      null,
      "User values type safety and enables TypeScript strict mode in all projects",
    );
    const sensitiveSnippet = "PRIVATE_SOUL_CONTENT_SHOULD_NOT_LEAK";
    const openai = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: `not valid json ${sensitiveSnippet}` } }],
          })),
        },
      },
    };

    const ctx = makeCtxWithMaintenanceFallbackModels(db, proposalsDb, openai);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let thrown: Error | null = null;
      try {
        await runGenerateProposalsForCli(ctx, { dryRun: false }, { resolvePath: (f) => f });
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.message).toContain("failure_type=invalid_json");
      expect(thrown?.message).not.toContain(sensitiveSnippet);
      const lastConsoleArg = String(consoleErrorSpy.mock.calls[consoleErrorSpy.mock.calls.length - 1]?.[0] ?? "");
      expect(lastConsoleArg).toContain("failure_type=invalid_json");
      expect(lastConsoleArg).not.toContain(sensitiveSnippet);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("allows response snippet logging in verbose mode but keeps thrown error sanitized", async () => {
    const db = new FactsDB(":memory:");
    const proposalsDb = new ProposalsDB(":memory:");
    insertScopedPattern(db, "global", null, "User consistently prefers functional composition over OOP patterns");
    insertScopedPattern(
      db,
      "global",
      null,
      "User values type safety and enables TypeScript strict mode in all projects",
    );
    const sensitiveSnippet = "VERBOSE_ONLY_SNIPPET";
    const openai = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: `still not valid json ${sensitiveSnippet}` } }],
          })),
        },
      },
    };

    const ctx = makeCtxWithMaintenanceFallbackModels(db, proposalsDb, openai);
    let thrown: Error | null = null;
    try {
      await runGenerateProposalsForCli(ctx, { dryRun: false, verbose: true }, { resolvePath: (f) => f });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.message).toContain("failure_type=invalid_json");
    expect(thrown?.message).not.toContain(sensitiveSnippet);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining(sensitiveSnippet));
  });
});

describe("buildAuditHealthReport — preReportWarnings (#1809)", () => {
  it("surfaces a pre-report warning in the report warnings array", () => {
    const db = new FactsDB(":memory:");
    db.store({
      text: "some fact",
      category: "technical",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const warning =
      "personaProposals is enabled but autoRecall.scopeFilter is not set; generate-proposals will include facts from all scopes.";

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500, {
      preReportWarnings: [warning],
    });

    expect(report.warnings).toContain(warning);
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
    expect(report.status).toBe("partial");
    expect(report.ok).toBe(false);
  });

  it("does not add a scopeFilter warning when preReportWarnings is empty", () => {
    const db = new FactsDB(":memory:");
    db.store({
      text: "some fact",
      category: "technical",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500, {
      preReportWarnings: [],
    });

    expect(report.warnings.some((w) => w.includes("scopeFilter"))).toBe(false);
  });
});
