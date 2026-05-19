/**
 * Commander-level coverage for hybrid-mem `config --json` output routing (#1519).
 * Mirrors the config action in register-corrections-and-pipeline.ts (createConfigOutputSink + runConfigView).
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigViewForCli } from "../cli/cmd-config.js";
import { createConfigOutputSink } from "../cli/config-output-sink.js";
import type { HandlerContext } from "../cli/handlers.js";
import { type Chainable, withExit } from "../cli/shared.js";

function makeCtx(overrides?: Partial<HandlerContext["cfg"]>): HandlerContext {
  const cfg = {
    mode: "minimal",
    verbosity: "normal",
    autoCapture: true,
    autoRecall: { enabled: true, entityLookup: { enabled: false }, retrievalDirectives: { enabled: false } },
    credentials: { enabled: true },
    procedures: { enabled: true },
    memoryTiering: { enabled: true },
    graph: { enabled: true },
    autoClassify: { enabled: true },
    nightlyCycle: { enabled: false },
    passiveObserver: { enabled: false },
    reflection: { enabled: true },
    personaProposals: { enabled: false },
    selfCorrection: { enabled: true },
    selfExtension: { enabled: true },
    crystallization: { enabled: true },
    extraction: { extractionPasses: true },
    goalStewardship: { enabled: false },
    activeTask: { enabled: true, ledger: "markdown", filePath: "ACTIVE-TASKS.md" },
    frustrationDetection: { enabled: false },
    crossAgentLearning: { enabled: true },
    toolEffectiveness: { enabled: true },
    documents: { enabled: true },
    provenance: { enabled: true },
    workflowTracking: { enabled: false },
    verification: { enabled: false },
    aliases: { enabled: false },
    reranking: { enabled: false },
    contextualVariants: { enabled: false },
    errorReporting: { enabled: false },
    costTracking: { enabled: true },
    queryExpansion: { enabled: true },
    wal: { enabled: true },
    ambient: {
      enabled: true,
      multiQuery: false,
      topicShiftThreshold: 0.4,
      maxQueriesPerTrigger: 4,
      budgetTokens: 2000,
    },
    futureDateProtection: { enabled: true, maxFreezeDays: 365 },
    ...overrides,
  } as unknown as HandlerContext["cfg"];

  return {
    cfg,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as HandlerContext;
}

/** Same wiring as registerManageCorrectionsAndPipeline `config` action. */
function registerConfigCommandLikeProduction(mem: Chainable, runConfigView: ManageBindingsRunConfigView): void {
  const configCommand = mem.command("config").description("Show current configuration and feature toggles");
  configCommand
    .option("--json", "Output configuration as JSON")
    .option("--format <format>", "Output format: text (default) or json")
    .action(
      withExit(async (opts?: { json?: boolean; format?: string }) => {
        const fmtRaw = (opts?.format ?? "text").trim().toLowerCase();
        if (opts?.json && opts.format && fmtRaw !== "json") {
          console.error("Error: do not combine --json with --format text.");
          process.exitCode = 1;
          return;
        }
        if (!opts?.json && fmtRaw !== "text" && fmtRaw !== "json") {
          console.error(`Error: invalid --format "${opts?.format ?? ""}". Use text or json.`);
          process.exitCode = 1;
          return;
        }
        const format = opts?.json ? "json" : fmtRaw === "json" ? "json" : "text";
        runConfigView(createConfigOutputSink(format), { format });
      }),
    );
}

type ManageBindingsRunConfigView = (
  sink: ReturnType<typeof createConfigOutputSink>,
  opts?: { format?: "text" | "json"; featuresOnly?: boolean },
) => void;

describe("hybrid-mem config CLI wiring (#1519)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("config --json writes parseable summary JSON to stdout via createConfigOutputSink", async () => {
    const ctx = makeCtx();
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerConfigCommandLikeProduction(program, (sink, opts) => runConfigViewForCli(ctx, sink, opts));

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["config", "--json"], { from: "user" });
      expect(exitSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(stdoutSpy).toHaveBeenCalled();
      const parsed = JSON.parse(stdoutChunks.join("").trim()) as Record<string, unknown>;
      expect(parsed.contract).toBe("openclaw.hybrid-mem.config-view.summary.v1");
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("config --json routes non-JSON diagnostics from runConfigView to stderr", async () => {
    const ctx = makeCtx();
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerConfigCommandLikeProduction(program, (sink, opts) => {
      runConfigViewForCli(ctx, sink, opts);
      if (opts?.format === "json") {
        sink.log("note: optional config diagnostic");
      }
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await program.parseAsync(["config", "--json"], { from: "user" });
      expect(stdoutSpy).toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledWith("note: optional config diagnostic");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
