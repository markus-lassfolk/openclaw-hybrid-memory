/**
 * CLI commands for distillation and extraction (distill, extract-*, generate-auto-skills, record-distill).
 */

import { type CommanderOptsParent, readHybridMemVerbose } from "./global-verbose.js";
import { type Chainable, withExit } from "./shared.js";
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
    opts: { days: number; dryRun: boolean; verbose?: boolean },
    sink: ExtractDailySink,
  ) => Promise<ExtractDailyResult>;
  runExtractProcedures: (opts: {
    sessionDir?: string;
    days?: number;
    dryRun: boolean;
    verbose?: boolean;
    full?: boolean;
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
    },
    sink: DistillCliSink,
  ) => Promise<DistillCliResult>;
  runExtractDirectives: (opts: { days?: number; verbose?: boolean; dryRun?: boolean; full?: boolean }) => Promise<{
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
    skipped?: boolean;
  }>;
  runExtractReinforcement: (opts: {
    days?: number;
    verbose?: boolean;
    dryRun?: boolean;
    full?: boolean;
  }) => Promise<ReinforcementExtractResult>;
  runGenerateProposals?: (opts: { dryRun: boolean; verbose?: boolean }) => Promise<{ created: number }>;
};

export function registerDistillCommands(mem: Chainable, ctx: DistillContext): void {
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

  mem
    .command("distill")
    .description(
      "Index session JSONL into memory (extract facts via LLM, dedup, store). Use distill-window for date range info.",
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
    )
    .option("--full", "Force full re-scan (ignore watermark, process all sessions in window)")
    .action(
      withExit(
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
          },
          cmd?: CommanderOptsParent,
        ) => {
          const sink = {
            log: (s: string) => console.log(s),
            warn: (s: string) => console.warn(s),
          };
          const maxSessions = Math.max(0, Number.parseInt(opts.maxSessions || "0", 10) || 0);
          const maxSessionTokens = Math.max(0, Number.parseInt(opts.maxSessionTokens || "0", 10) || 0);
          const days = opts.days != null ? Number.parseInt(opts.days, 10) : undefined;
          const result = await runDistill(
            {
              dryRun: !!opts.dryRun,
              all: !!opts.all,
              days: Number.isFinite(days) ? days : undefined,
              since: opts.since?.trim() || undefined,
              model: opts.model,
              verbose: !!opts.verbose || readHybridMemVerbose(cmd),
              maxSessions: maxSessions > 0 ? maxSessions : undefined,
              maxSessionTokens: maxSessionTokens > 0 ? maxSessionTokens : undefined,
              full: !!opts.full,
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
        },
      ),
    );

  mem
    .command("distill-window")
    .description(
      "Print the session distillation window (full or incremental). Use at start of a distillation job to decide what to process.",
    )
    .option("--json", "Output machine-readable JSON only (mode, startDate, endDate, mtimeDays)")
    .action(
      withExit(async (opts: { json?: boolean }) => {
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
    );

  mem
    .command("record-distill")
    .description(
      "Record that session distillation was run (writes timestamp to .distill_last_run for 'verify' to show)",
    )
    .action(
      withExit(async () => {
        const result = await runRecordDistill();
        console.log(`Recorded distillation run: ${result.timestamp}`);
        console.log(`Written to ${result.path}. Run 'openclaw hybrid-mem verify' to see it.`);
      }),
    );

  mem
    .command("extract-daily")
    .description("Extract structured facts from daily memory files")
    .option("--days <n>", "How many days back to scan", "7")
    .option("--dry-run", "Show extractions without storing")
    .option("-v, --verbose", "Log each extracted fact as it is stored")
    .action(
      withExit(async (opts: { days: string; dryRun?: boolean; verbose?: boolean }, cmd?: CommanderOptsParent) => {
        const daysBack = Number.parseInt(opts.days, 10);
        const result = await runExtractDaily(
          {
            days: daysBack,
            dryRun: !!opts.dryRun,
            verbose: !!opts.verbose || readHybridMemVerbose(cmd),
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
      }),
    );

  mem
    .command("extract-procedures")
    .description("Procedural memory: extract tool-call sequences from session JSONL and store as procedures")
    .option("--dir <path>", "Session directory (default: config procedures.sessionsDir)")
    .option("--days <n>", "Only sessions modified in last N days (default: all in dir)", "")
    .option("--dry-run", "Show what would be stored without writing")
    .option("-v, --verbose", "Log why each session was skipped (no_task_intent, fewer_than_2_steps)")
    .option("--full", "Force full re-scan (ignore watermark, process all sessions in window)")
    .action(
      withExit(
        async (
          opts: {
            dir?: string;
            days?: string;
            dryRun?: boolean;
            verbose?: boolean;
            full?: boolean;
          },
          cmd?: CommanderOptsParent,
        ) => {
          const days = opts.days != null ? Number.parseInt(opts.days, 10) : undefined;
          const result = await runExtractProcedures({
            sessionDir: opts.dir,
            days: Number.isFinite(days) ? days : undefined,
            dryRun: !!opts.dryRun,
            verbose: !!opts.verbose || readHybridMemVerbose(cmd),
            full: !!opts.full,
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
        },
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
            verbose: !!opts.verbose || readHybridMemVerbose(cmd),
            bypassDuplicateSkillCache: opts.bypassSkillDuplicateCache === true,
          });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          const s = result.summary;
          const counts = s
            ? `candidates=${s.candidates}, eligible=${s.eligible}, drafted=${s.drafted}, rejected=${s.rejected}, deferred=${s.deferred}, failedValidation=${s.failedValidation}, failedEval=${s.failedEval}`
            : `generated=${result.generated}, skipped=${result.skipped}`;
          if (result.dryRun) {
            console.log(`\n[dry-run] Procedure skill promotion summary: ${counts}`);
          } else {
            console.log(`\nProcedure skill promotion summary: ${counts}`);
            for (const p of result.paths) console.log(`  ${p}`);
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
          verbose: !!opts?.verbose || readHybridMemVerbose(cmd),
        });
        if (opts?.dryRun) {
          console.log(`\n[dry-run] Would create ${result.created} proposal(s).`);
        } else {
          console.log(`\nCreated ${result.created} proposal(s).`);
        }
      }),
    );

  mem
    .command("extract-directives")
    .description("Extract directive incidents from session JSONL (10 categories)")
    .option("--days <n>", "Scan sessions from last N days (default: 3)", "3")
    .option("-v, --verbose", "Log each directive as it is detected")
    .option("--dry-run", "Show what would be extracted without storing")
    .option("--full", "Force full re-scan (ignore watermark, process all sessions in window)")
    .action(
      withExit(
        async (
          opts: {
            days?: string;
            verbose?: boolean;
            dryRun?: boolean;
            full?: boolean;
          },
          cmd?: CommanderOptsParent,
        ) => {
          const days = Number.parseInt(opts.days ?? "3", 10);
          const result = await runExtractDirectives({
            days,
            verbose: !!opts.verbose || readHybridMemVerbose(cmd),
            dryRun: opts.dryRun,
            full: opts.full,
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
            if (result.partial) {
              console.log("Status: partial (rejections detected; cursor not advanced).");
            }
            if (result.dedupeDegraded) {
              console.log("Status: degraded dedupe (lexical-only fallback used).");
            }
            if (result.directiveDedupeMode) {
              console.log(`Status: directiveDedupeMode=${result.directiveDedupeMode}`);
            }
          }
        },
      ),
    );

  mem
    .command("extract-reinforcement")
    .description("Extract reinforcement incidents from session JSONL and annotate facts/procedures")
    .option("--days <n>", "Scan sessions from last N days (default: 3)", "3")
    .option("-v, --verbose", "Log each reinforcement as it is detected")
    .option("--dry-run", "Show what would be annotated without storing")
    .option("--full", "Force full re-scan (ignore watermark, process all sessions in window)")
    .action(
      withExit(
        async (
          opts: {
            days?: string;
            verbose?: boolean;
            dryRun?: boolean;
            full?: boolean;
          },
          cmd?: CommanderOptsParent,
        ) => {
          const days = Number.parseInt(opts.days ?? "3", 10);
          const result = await runExtractReinforcement({
            days,
            verbose: !!opts.verbose || readHybridMemVerbose(cmd),
            dryRun: opts.dryRun,
            full: opts.full,
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
                if (status === "failed_annotation" || status === "degraded_model_or_parser") {
                  process.exitCode = 1;
                }
              }
            } else if (factsReinforced > 0 && result.annotationReasons?.errors && result.annotationReasons.errors > 0) {
              process.exitCode = 2;
            }
          }
        },
      ),
    );
}
