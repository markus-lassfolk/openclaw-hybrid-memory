/**
 * run-all maintenance CLI — dry-run listing and backfill-decay idempotency (#2026.5.190).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageAgentsAuditRunall } from "../cli/commands/manage/register-agents-audit-runall.js";

function makeBindings(overrides: Partial<ManageBindings> & { factsDb: ManageBindings["factsDb"] }): ManageBindings {
  return {
    vectorDb: {
      delete: vi.fn().mockResolvedValue(true),
    },
    auditStore: null,
    agentHealthStore: null,
    resolvedSqlitePath: overrides.resolvedSqlitePath ?? null,
    BACKFILL_DECAY_MARKER: ".backfill-decay-done",
    runCompaction: vi.fn().mockResolvedValue({ hot: 0, warm: 0, cold: 0 }),
    runDistill: null,
    runExtractDaily: null,
    runExtractDirectives: null,
    runExtractReinforcement: null,
    runExtractImplicitFeedback: null,
    runExtractProcedures: null,
    runGenerateAutoSkills: null,
    runReflectIdentity: null,
    runGenerateProposals: null,
    runSelfCorrectionRun: vi.fn().mockResolvedValue(undefined),
    runBuildLanguageKeywords: vi.fn().mockResolvedValue({ ok: true, languagesAdded: 0 }),
    reflectionConfig: { defaultWindow: 7, model: "test-model" },
    runReflection: vi.fn().mockResolvedValue({ patternsStored: 0 }),
    runReflectionRules: vi.fn().mockResolvedValue({ rulesStored: 0 }),
    runReflectionMeta: vi.fn().mockResolvedValue({ metaStored: 0 }),
    ...overrides,
  } as unknown as ManageBindings;
}

describe("run-all maintenance CLI", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("dry-run lists steps without executing maintenance handlers", async () => {
    const backfillDecay = vi.fn();
    const prune = vi.fn();
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerManageAgentsAuditRunall(
      mem,
      makeBindings({
        factsDb: {
          backfillDecay,
          prune,
          listExpiredFactIdsPendingPrune: () => [],
          countActiveFactsByCategory: () => 0,
        } as never,
      }),
    );

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => {
      lines.push(String(s));
    });

    await mem.parseAsync(["run-all", "--dry-run"], { from: "user" });

    expect(lines.some((l) => l.includes("run-all (dry-run)"))).toBe(true);
    expect(lines.some((l) => l.includes("backfill-decay"))).toBe(true);
    expect(lines.some((l) => l.includes("prune"))).toBe(true);
    expect(backfillDecay).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  it("writes backfill-decay marker once and skips backfill on a second run-all", async () => {
    const root = mkdtempSync(join(tmpdir(), "run-all-idempotent-"));
    roots.push(root);
    const memoryDir = join(root, "memory");
    mkdirSync(memoryDir, { recursive: true });
    const sqlitePath = join(memoryDir, "facts.db");
    const markerPath = join(memoryDir, ".backfill-decay-done");

    const backfillDecay = vi.fn().mockReturnValue({ fact: 2 });
    const prune = vi.fn().mockReturnValue(0);
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerManageAgentsAuditRunall(
      mem,
      makeBindings({
        resolvedSqlitePath: sqlitePath,
        factsDb: {
          backfillDecay,
          prune,
          listExpiredFactIdsPendingPrune: () => [],
          countActiveFactsByCategory: () => 0,
        } as never,
      }),
    );

    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await mem.parseAsync(["run-all"], { from: "user" });
    expect(backfillDecay).toHaveBeenCalledTimes(1);
    expect(existsSync(markerPath)).toBe(true);

    backfillDecay.mockClear();
    await mem.parseAsync(["run-all", "--verbose"], { from: "user" });
    expect(backfillDecay).not.toHaveBeenCalled();
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it("still runs prune when backfill marker exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "run-all-marker-"));
    roots.push(root);
    const memoryDir = join(root, "memory");
    mkdirSync(memoryDir, { recursive: true });
    const sqlitePath = join(memoryDir, "facts.db");
    writeFileSync(join(memoryDir, ".backfill-decay-done"), `${new Date().toISOString()}\n`, "utf-8");

    const backfillDecay = vi.fn();
    const prune = vi.fn().mockReturnValue(3);
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerManageAgentsAuditRunall(
      mem,
      makeBindings({
        resolvedSqlitePath: sqlitePath,
        factsDb: {
          backfillDecay,
          prune,
          listExpiredFactIdsPendingPrune: () => ["id-1"],
          countActiveFactsByCategory: () => 0,
        } as never,
      }),
    );

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => lines.push(String(s)));

    await mem.parseAsync(["run-all"], { from: "user" });

    expect(backfillDecay).not.toHaveBeenCalled();
    expect(prune).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.includes("Pruned 3 expired facts"))).toBe(true);
  });
});
