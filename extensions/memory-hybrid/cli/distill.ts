/**
 * CLI commands for distillation and extraction (distill, extract-*, generate-auto-skills, record-distill).
 */

import {
  type DistillCommandNames,
  FLAT_DISTILL_COMMAND_NAMES,
  GROUPED_DISTILL_COMMAND_NAMES,
  deprecatedAction,
} from "./commands/cli-group-utils.js";
import { type CommanderOptsParent, resolveHybridMemVerbose } from "./global-verbose.js";
import { registerScanMaintenanceOverrideOptions, scanMaintenanceOverridePayload } from "./maintenance-overrides.js";
import { createCommandGroup, type Chainable, withExit } from "./shared.js";
import type { ReinforcementExtractResult } from "../services/reinforcement-extract.js";
import type {
  DistillCliResult,
  DistillCliSink,
  DistillWindowResult,
  ExtractDailyResult,
  ExtractDailySink,
  ExtractProceduresResult,
  GenerateAutoSkillsResult,
  RecordDistillResult,
} from "./types.js";

export type DistillContext = {
  runDistillWindow: (opts: { json: boolean }) => Promise<DistillWindowResult>;
  runRecordDistill: () => Promise<RecordDistillResult>;
  runExtractDaily: (
    opts: { days: number; dryRun: boolean; verbose?: boolean; force?: boolean; full?: boolean },
    sink: ExtractDailySink,
  ) => Promise<ExtractDailyResult>;
  runExtractProcedures: (opts: {
    sessionDir?: string;
    days?: number;
    dryRun: boolean;
    verbose?: boolean;
    full?: boolean;
    force?: boolean;
  }) => Promise<ExtractProceduresResult>;
  runGenerateAutoSkills: (opts: {
    dryRun: boolean;
    apply?: boolean;
    verbose?: boolean;
    max?: number;
    policy?: string;
    json?: boolean;
    bypassDuplicateSkillCache?: boolean;
  }) => Promise<GenerateAutoSkillsResult>;
  runDistill: (
    opts: {
      dryRun: boolean;
      all?: boolean;
      days?: number;
      since?: string;
      model?: string;
      verbose?: boolean;
      maxSessions?: number;
      maxSessionTokens?: number;
      full?: boolean;
      force?: boolean;
    },
    sink: DistillCliSink,
  ) => Promise<DistillCliResult>;
  runExtractDirectives: (opts: {
    days?: number;
    verbose?: boolean;
    dryRun?: boolean;
    full?: boolean;
    force?: boolean;
  }) => Promise<{
    incidents: Array<{
      userMessage: string;
      categories: string[];
      extractedRule: string;
      precedingAssistant: string;
      confidence: number;
      timestamp?: string;
      sessionFile: string;
    }>;
    sessionsScanned: number;
    stored?: number;
    rejected?: number;
    partial?: boolean;
    dedupeDegraded?: boolean;
    directiveDedupeMode?: "vector" | "lexical-only" | "mixed";
    directiveRejected?: {
      permanent: number;
      retryable: number;
      parserOrModelFailure: number;
      boundedPartialRetry: number;
    };
    cursorAdvanced?: boolean;
    cursorBlockedReason?: "retryable_rejections" | "parser_or_model_failure" | "bounded_partial_retry";
    skipped?: boolean;
  }>;
  runExtractReinforcement: (opts: {
    days?: number;
    verbose?: boolean;
    dryRun?: boolean;
    full?: boolean;
    force?: boolean;
  }) => Promise<ReinforcementExtractResult>;
  runGenerateProposals?: (opts: { dryRun: boolean; verbose?: boolean }) => Promise<{
    created: number;
    semanticOutcome?: string;
  }>;
};

export type DistillRegistrationOptions = {
  names?: DistillCommandNames;
  /** Register deprecated flat aliases on this parent (typically the hybrid-mem root). */
  flatDeprecatedOn?: Chainable;
};

/**
 * Parse a --days CLI flag into a positive integer. Returns `undefined` when `raw` is missing or
 * empty (caller applies its own default/optional semantics), or `null` after printing an error
 * and setting process.exitCode when `raw` is present but not a positive integer -- callers must
 * `return` immediately when they see `null` instead of silently falling back to a default, since
 * a negative/NaN days value previously loop-guarded (`for (let d = 0; d < daysBack; d++)`) into a
 * silent zero-days no-op that still reported success.
 */
function parseDaysFlag(raw: string | undefined): number | undefined | null {
  if (raw == null || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.error(`error: --days must be a positive integer, got: ${raw}`);
    process.exitCode = 1;
    return null;
  }
  return parsed;
}

export function registerDistillCommands(mem: Chainable, ctx: DistillContext, opts?: DistillRegistrationOptions): void {
  if (opts?.flatDeprecatedOn) {
    registerDistillCommandsOnParent(opts.flatDeprecatedOn, ctx, FLAT_DISTILL_COMMAND_NAMES, deprecatedAction, {
      skipDistillMain: true,
    });
    return;
  }
  const names = opts?.names ?? FLAT_DISTILL_COMMAND_NAMES;
  registerDistillCommandsOnParent(mem, ctx, names);
}

function registerDistillCommandsOnParent(
  mem: Chainable,
  ctx: DistillContext,
  names: DistillCommandNames,
  wrapAction?: (
    oldPath: string,
    newPath: string,
    fn: (...args: any[]) => void | Promise<void>,
  ) => (...args: any[]) => void | Promise<void>,
  opts?: { skipDistillMain?: boolean },
): void {
  const {
    runDistillWindow,
    runRecordDistill,
    runExtractDaily,
    runExtractProcedures,
    runGenerateAutoSkills,
    runDistill,
    runExtractDirectives,
    runExtractReinforcement,
    runGenerateProposals,
  } = ctx;

  const isDefaultRun = names.distill === "run";
  const groupedPath = (sub: string) => `distill ${sub}`;
  const maybeWrap = (
    flatPath: string,
    sub: string,
    fn: (...args: any[]) => void | Promise<void>,
  ): ((...args: any[]) => void | Promise<void>) => (wrapAction ? wrapAction(flatPath, groupedPath(sub), fn) : fn);

  if (!opts?.skipDistillMain) {
    registerScanMaintenanceOverrideOptions(
      (mem.command as (n: string, opts?: unknown) => Chainable)(
        names.distill,
        isDefaultRun ? ({ isDefault: true } as never) : undefined,
      )
        .description(
          isDefaultRun
            ? "Extract facts from session JSONL via LLM (dedup, store). Use 'distill window' for date range info."
            : "Index session JSONL into memory (extract facts via LLM, dedup, store). Use distill-window for date range info.",
        )
        .option("--dry-run", "Show what would be processed without storing")
        .option("--all", "Process all sessions (last 90 days)")
        .option("--days <n>", "Process sessions from last N days (default: 3)", "3")
        .option("--since <date>", "Process sessions since date (YYYY-MM-DD)")
        .option(
          "--model <model>",
          "LLM for extraction (recommended: gemini-3.1-pro-preview for 1M context). Default: config.distill.defaultModel or gemini-3.1-pro-preview",
        )
        .option("-v, --verbose", "Log each fact as it is stored")
        .option("--max-sessions <n>", "Limit sessions to process (for cost control)", "0")
        .option(
          "--max-session-tokens <n>",
          "Max tokens per session chunk; oversized sessions are split into overlapping chunks (default: batch limit)",
          "0",
        ),
    ).action(
      withExit(
        maybeWrap(
          "distill",
          names.distill,
          async (
            opts: {
              dryRun?: boolean;
              all?: boolean;
              days?: string;
              since?: string;
              model?: string;
              verbose?: boolean;
              maxSessions?: string;
              maxSessionTokens?: string;
              full?: boolean;
              force?: boolean;
            },
            cmd?: CommanderOptsParent,
          ) => {
            const sink = {
              log: (s: string) => console.log(s),
              warn: (s: string) => console.warn(s),
            };
            const maxSessions = Math.max(0, Number.parseInt(opts.maxSessions || "0", 10) || 0);
            const maxSessionTokens = Math.max(0, Number.parseInt(opts.maxSessionTokens || "0", 10) || 0);
            const days = parseDaysFlag(opts.days);
            if (days === null) return;
            const overrides = scanMaintenanceOverridePayload(opts);
            const result = await runDistill(
              {
                dryRun: !!opts.dryRun,
                all: !!opts.all,
                days,
                since: opts.since?.trim() || undefined,
                model: opts.model,
                verbose: resolveHybridMemVerbose(opts, cmd),
                maxSessions: maxSessions > 0 ? maxSessions : undefined,
                maxSessionTokens: maxSessionTokens > 0 ? maxSessionTokens : undefined,
                ...overrides,
              },
              sink,
            );
            if (result.dryRun) {
              console.log(`\nWould extract ${result.factsExtracted} facts from ${result.sessionsScanned} sessions.`);
            } else {
              console.log(
                `\nDistill done: ${result.stored} stored, ${result.dedupSkipped} skipped (${result.factsExtracted} extracted from ${result.sessionsScanned} sessions).`,
              );
            }
            const semantic =
              result.semanticOutcome ??
              (result.partialFailure ? "partial" : result.semanticEmpty ? "failed" : "success");
            console.log(
              `distill stored=${result.stored} sessions=${result.sessionsScanned} batchFailures=${result.batchFailures ?? 0} semantic=${semantic}`,
            );
            if (result.semanticEmpty) {
              process.exitCode = 1;
            } else if (result.partialFailure) {
              process.exitCode = 2;
            }
          },
        ),
      ),
    );
  }

  mem
    .command(names.distillWindow)
    .description(
      "Print the session distillation window (full or incremental). Use at start of a distillation job to decide what to process.",
    )
    .option("--json", "Output machine-readable JSON only (mode, startDate, endDate, mtimeDays)")
    .action(
      withExit(
        maybeWrap("distill-window", names.distillWindow, async (opts: { json?: boolean }) => {
          const result = await runDistillWindow({ json: !!opts.json });
          if (opts.json) {
            console.log(JSON.stringify(result));
            return;
          }
          console.log(`Distill window: ${result.mode}`);
          console.log(`  startDate: ${result.startDate}`);
          console.log(`  endDate: ${result.endDate}`);
          console.log(`  mtimeDays: ${result.mtimeDays} (use find ... -mtime -${result.mtimeDays} for session files)`);
          console.log("Process sessions from that window; distill will record the run automatically.");
        }),
      ),
    );

  mem
    .command(names.recordDistill)
    .description(
      "Record that session distillation was run (writes timestamp to .distill_last_run for 'verify' to show)",
    )
    .action(
      withExit(
        maybeWrap("record-distill", names.recordDistill, async () => {
          const result = await runRecordDistill();
          console.log(`Recorded distillation run: ${result.timestamp}`);
          console.log(`Written to ${result.path}. Run 'openclaw hybrid-mem verify' to see it.`);
        }),
      ),
    );

  registerScanMaintenanceOverrideOptions(
    mem
      .command(names.extractDaily)
      .description("Extract structured facts from daily memory files")
      .option("--days <n>", "How many days back to scan", "7")
      .option("--dry-run", "Show extractions without storing")
      .option("-v, --verbose", "Log each extracted fact as it is stored"),
  ).action(
    withExit(
      maybeWrap(
        "extract-daily",
        names.extractDaily,
        async (
          opts: { days: string; dryRun?: boolean; verbose?: boolean; force?: boolean; full?: boolean },
          cmd?: CommanderOptsParent,
        ) => {
          const daysBack = parseDaysFlag(opts.days);
          if (daysBack == null) return;
          const result = await runExtractDaily(
            {
              days: daysBack,
              dryRun: !!opts.dryRun,
              verbose: resolveHybridMemVerbose(opts, cmd),
              ...scanMaintenanceOverridePayload(opts),
            },
            { log: (s) => console.log(s), warn: (s) => console.warn(s) },
          );
          if (result.dryRun) {
            console.log(`\nWould extract: ${result.totalExtracted} facts from last ${result.daysBack} days`);
          } else {
            console.log(
              `\nExtracted ${result.totalStored} new facts (${result.totalExtracted} candidates, ${
                result.totalExtracted - result.totalStored
              } duplicates skipped)`,
            );
          }
          const vectorFailures = result.vectorFailures ?? 0;
          const semantic = result.semanticOutcome ?? (vectorFailures > 0 ? "partial" : "success");
          console.log(
            `extract-daily stored=${result.totalStored} vector_failures=${vectorFailures} semantic=${semantic}`,
          );
          if (vectorFailures > 0 || semantic === "partial") {
            process.exitCode = 2;
          }
        },
      ),
    ),
  );

  registerScanMaintenanceOverrideOptions(
    mem
      .command(names.extractProcedures)
      .description("Procedural memory: extract tool-call sequences from session JSONL and store as procedures")
      .option("--dir <path>", "Session directory (default: config procedures.sessionsDir)")
      .option("--days <n>", "Only sessions modified in last N days (default: all in dir)", "")
      .option("--dry-run", "Show what would be stored without writing")
      .option("-v, --verbose", "Log why each session was skipped (no_task_intent, fewer_than_2_steps)"),
  ).action(
    withExit(
      maybeWrap(
        "extract-procedures",
        names.extractProcedures,
        async (
          opts: {
            dir?: string;
            days?: string;
            dryRun?: boolean;
            verbose?: boolean;
            full?: boolean;
            force?: boolean;
          },
          cmd?: CommanderOptsParent,
        ) => {
          const days = parseDaysFlag(opts.days);
          if (days === null) return;
          const result = await runExtractProcedures({
            sessionDir: opts.dir,
            days,
            dryRun: !!opts.dryRun,
            verbose: resolveHybridMemVerbose(opts, cmd),
            ...scanMaintenanceOverridePayload(opts),
          });
          if (result.dryRun) {
            console.log(
              `\n[dry-run] Sessions scanned: ${result.sessionsScanned}, procedures that would be stored: ${result.proceduresStored} (${result.positiveCount} positive, ${result.negativeCount} negative)`,
            );
          } else {
            console.log(
              `\nSessions scanned: ${result.sessionsScanned}; procedures stored/updated: ${result.proceduresStored} (${result.positiveCount} positive, ${result.negativeCount} negative)`,
            );
          }
          const readFailures = result.readFailures ?? 0;
          const semantic = readFailures > 0 ? "partial" : "success";
          console.log(
            `extract-procedures sessions=${result.sessionsScanned} readFailures=${readFailures} semantic=${semantic}`,
          );
          if (readFailures > 0) {
            process.exitCode = 2;
          }
        },
      ),
    ),
  );

  mem
    .command("generate-auto-skills")
    .description("Generate verified draft SKILL.md + recipe/eval metadata for safe validated procedures")
    .option("--dry-run", "Show what would be generated without writing (default unless --apply is passed)")
    .option("--apply", "Apply policy result. Draft writes only occur when the effective policy is auto-safe.")
    .option("--max <n>", "Maximum procedures to inspect", "10")
    .option(
      "--policy <policy>",
      "Promotion policy: draft-only, manual, auto-safe (default: dry-run draft-only; non-dry-run/apply defaults to auto-safe for legacy maintenance callers)",
    )
    .option("--json", "Emit structured JSON summary")
    .option("--bypass-skill-duplicate-cache", "Re-read every SKILL.md for duplicate detection (ignore mtime cache)")
    .option("-v, --verbose", "Log each decision and generated skill path")
    .action(
      withExit(
        async (
          opts: {
            dryRun?: boolean;
            apply?: boolean;
            verbose?: boolean;
            max?: string;
            policy?: string;
            json?: boolean;
            bypassSkillDuplicateCache?: boolean;
          },
          cmd?: CommanderOptsParent,
        ) => {
          const max = Number.parseInt(opts.max ?? "10", 10);
          if (!Number.isFinite(max) || max < 1) {
            console.error("error: --max must be a positive integer");
            process.exitCode = 1;
            return;
          }
          const apply = opts.apply === true;
          const result = await runGenerateAutoSkills({
            dryRun: !apply || opts.dryRun === true,
            apply,
            max,
            policy: opts.policy,
            json: opts.json,
            verbose: resolveHybridMemVerbose(opts, cmd),
            bypassDuplicateSkillCache: opts.bypassSkillDuplicateCache === true,
          });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          const s = result.summary;
          const failedValidation = s?.failedValidation ?? 0;
          const failedEval = s?.failedEval ?? 0;
          const partial = failedValidation > 0 || failedEval > 0;
          const counts = s
            ? `candidates=${s.candidates}, eligible=${s.eligible}, drafted=${s.drafted}, rejected=${s.rejected}, deferred=${s.deferred}, failedValidation=${failedValidation}, failedEval=${failedEval}`
            : `generated=${result.generated}, skipped=${result.skipped}`;
          const semanticSuffix = ` semantic=${partial ? "partial" : "success"}`;
          if (result.dryRun) {
            console.log(`\n[dry-run] Procedure skill promotion summary: ${counts}${semanticSuffix}`);
          } else {
            console.log(`\nProcedure skill promotion summary: ${counts}${semanticSuffix}`);
            for (const p of result.paths) console.log(`  ${p}`);
          }
          if (partial) {
            process.exitCode = 2;
          }
        },
      ),
    );

  mem
    .command("generate-proposals")
    .description("Generate persona proposals from reflection insights (patterns, rules, meta). Use after reflect-meta.")
    .option("--dry-run", "Show what would be proposed without creating")
    .option("-v, --verbose", "Log each proposal created")
    .action(
      withExit(async (opts?: { dryRun?: boolean; verbose?: boolean }, cmd?: CommanderOptsParent) => {
        if (!runGenerateProposals) {
          console.log("Generate-proposals not available (personaProposals disabled).");
          return;
        }
        const result = await runGenerateProposals({
          dryRun: !!opts?.dryRun,
          verbose: resolveHybridMemVerbose(opts, cmd),
        });
        if (opts?.dryRun) {
          console.log(`\n[dry-run] Would create ${result.created} proposal(s).`);
        } else {
          console.log(`\nCreated ${result.created} proposal(s).`);
        }
        const semantic = result.semanticOutcome ?? "success";
        console.log(`generate-proposals created=${result.created} semantic=${semantic}`);
        if (semantic === "partial" || semantic === "failed" || semantic === "semantic_empty") {
          process.exitCode = 2;
        }
      }),
    );

  registerScanMaintenanceOverrideOptions(
    mem
      .command(names.extractDirectives)
      .description("Extract directive incidents from session JSONL (10 categories)")
      .option("--days <n>", "Scan sessions from last N days (default: 3)", "3")
      .option("-v, --verbose", "Log each directive as it is detected")
      .option("--dry-run", "Show what would be extracted without storing"),
  ).action(
    withExit(
      maybeWrap(
        "extract-directives",
        names.extractDirectives,
        async (
          opts: {
            days?: string;
            verbose?: boolean;
            dryRun?: boolean;
            full?: boolean;
            force?: boolean;
          },
          cmd?: CommanderOptsParent,
        ) => {
          const days = parseDaysFlag(opts.days ?? "3");
          if (days == null) return;
          const result = await runExtractDirectives({
            days,
            verbose: resolveHybridMemVerbose(opts, cmd),
            dryRun: opts.dryRun,
            ...scanMaintenanceOverridePayload(opts),
          });
          console.log(`\nSessions scanned: ${result.sessionsScanned}; directives found: ${result.incidents.length}`);
          if (opts.dryRun) {
            console.log(`[dry-run] Would store ${result.incidents.length} directives as facts.`);
          } else {
            const stored = result.stored ?? result.incidents.length;
            const skipped = result.incidents.length - stored;
            console.log(
              `Stored ${stored} directives as facts${skipped > 0 ? ` (${skipped} duplicates skipped)` : ""}.`,
            );
            if ((result.rejected ?? 0) > 0) {
              console.log(`Rejected ${result.rejected} non-durable/untrusted directive candidate(s).`);
            }
            if (result.directiveRejected) {
              console.log(
                `Status: directiveRejected=permanent:${result.directiveRejected.permanent},retryable:${result.directiveRejected.retryable},parserOrModelFailure:${result.directiveRejected.parserOrModelFailure},boundedPartialRetry:${result.directiveRejected.boundedPartialRetry}`,
              );
            }
            if (result.partial) {
              console.log("Status: partial (retryable rejections detected; cursor not advanced).");
            }
            if (result.dedupeDegraded) {
              console.log("Status: degraded dedupe (lexical-only fallback used).");
            }
            if (result.directiveDedupeMode) {
              console.log(`Status: directiveDedupeMode=${result.directiveDedupeMode}`);
            }
            if (typeof result.cursorAdvanced === "boolean") {
              console.log(`Status: cursorAdvanced=${result.cursorAdvanced}`);
            }
            if (result.cursorBlockedReason) {
              console.log(`Status: cursorBlockedReason=${result.cursorBlockedReason}`);
              process.exitCode = 2;
            }
            if (result.partial && result.cursorAdvanced === false) {
              process.exitCode = 2;
            }
          }
        },
      ),
    ),
  );

  registerScanMaintenanceOverrideOptions(
    mem
      .command(names.extractReinforcement)
      .description("Extract reinforcement incidents from session JSONL and annotate facts/procedures")
      .option("--days <n>", "Scan sessions from last N days (default: 3)", "3")
      .option("-v, --verbose", "Log each reinforcement as it is detected")
      .option("--dry-run", "Show what would be annotated without storing"),
  ).action(
    withExit(
      maybeWrap(
        "extract-reinforcement",
        names.extractReinforcement,
        async (
          opts: {
            days?: string;
            verbose?: boolean;
            dryRun?: boolean;
            full?: boolean;
            force?: boolean;
          },
          cmd?: CommanderOptsParent,
        ) => {
          const days = parseDaysFlag(opts.days ?? "3");
          if (days == null) return;
          const result = await runExtractReinforcement({
            days,
            verbose: resolveHybridMemVerbose(opts, cmd),
            dryRun: opts.dryRun,
            ...scanMaintenanceOverridePayload(opts),
          });
          console.log(
            `\nSessions scanned: ${result.sessionsScanned}; reinforcement incidents found: ${result.incidents.length}`,
          );
          if (opts.dryRun) {
            console.log("[dry-run] Would annotate facts/procedures with reinforcement data.");
          } else {
            const factsReinforced = result.annotated ?? 0;
            console.log(`Annotated ${factsReinforced} facts with reinforcement data.`);
            if (result.incidents.length > 0 && factsReinforced === 0) {
              const reasons = result.annotationReasons;
              if (reasons) {
                console.log(
                  `Annotation reason breakdown: noRecalledIds=${reasons.noRecalledIds} reinforced=${reasons.reinforced} recalledIdsNoMatch=${reasons.recalledIdsNoMatch} errors=${reasons.errors}`,
                );
              }
              const status = result.annotationStatus;
              if (status) {
                console.log(`Annotation status: ${status}`);
                if (result.annotationDiagnostic) {
                  const diagnostic = result.annotationDiagnostic;
                  console.log(`Annotation diagnostic: ${diagnostic.kind} — ${diagnostic.summary}`);
                  for (const action of diagnostic.recommendedActions) {
                    console.log(`  next: ${action}`);
                  }
                }
                if (status === "failed_annotation" || status === "degraded_model_or_parser") {
                  process.exitCode = 1;
                }
              }
            } else if (factsReinforced > 0 && result.annotationReasons?.errors && result.annotationReasons.errors > 0) {
              process.exitCode = 2;
            }
            if (result.partialBatchFailure) {
              process.exitCode = 2;
            }
          }
        },
      ),
    ),
  );
}

export function registerDistillGroup(mem: Chainable, ctx: DistillContext): void {
  const group = createCommandGroup(mem, "distill", "Session distillation and extraction");
  registerDistillCommandsOnParent(group, ctx, GROUPED_DISTILL_COMMAND_NAMES);
  registerDistillCommands(mem, ctx, { flatDeprecatedOn: mem });
}
