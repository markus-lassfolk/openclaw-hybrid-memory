/**
 * CLI commands for distillation and extraction (distill, extract-*, generate-auto-skills, record-distill).
 */

import type {
  DistillWindowResult,
  RecordDistillResult,
  ExtractDailyResult,
  ExtractDailySink,
  ExtractProceduresResult,
  GenerateAutoSkillsResult,
  DistillCliResult,
  DistillCliSink,
} from "./types.js";
import { withExit, type Chainable } from "./shared.js";

export type DistillContext = {
  runDistillWindow: (opts: { json: boolean }) => Promise<DistillWindowResult>;
  runRecordDistill: () => Promise<RecordDistillResult>;
  runExtractDaily: (opts: { days: number; dryRun: boolean }, sink: ExtractDailySink) => Promise<ExtractDailyResult>;
  runExtractProcedures: (opts: { sessionDir?: string; days?: number; dryRun: boolean }) => Promise<ExtractProceduresResult>;
  runGenerateAutoSkills: (opts: { dryRun: boolean }) => Promise<GenerateAutoSkillsResult>;
  runDistill: (opts: { dryRun: boolean; all?: boolean; days?: number; since?: string; model?: string; verbose?: boolean; maxSessions?: number; maxSessionTokens?: number }, sink: DistillCliSink) => Promise<DistillCliResult>;
  runExtractDirectives: (opts: { days?: number; verbose?: boolean; dryRun?: boolean }) => Promise<{ incidents: Array<{ userMessage: string; categories: string[]; extractedRule: string; precedingAssistant: string; confidence: number; timestamp?: string; sessionFile: string }>; sessionsScanned: number; stored?: number }>;
  runExtractReinforcement: (opts: { days?: number; verbose?: boolean; dryRun?: boolean }) => Promise<{ incidents: Array<{ userMessage: string; agentBehavior: string; recalledMemoryIds: string[]; toolCallSequence: string[]; confidence: number; timestamp?: string; sessionFile: string }>; sessionsScanned: number }>;
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
    .description("Index session JSONL into memory (extract facts via LLM, dedup, store). Use distill-window for date range info.")
    .option("--dry-run", "Show what would be processed without storing")
    .option("--all", "Process all sessions (last 90 days)")
    .option("--days <n>", "Process sessions from last N days (default: 3)", "3")
    .option("--since <date>", "Process sessions since date (YYYY-MM-DD)")
    .option("--model <model>", "LLM for extraction (recommended: gemini-3-pro-preview for 1M context). Default: config.distill.defaultModel or gemini-3-pro-preview")
    .option("--verbose", "Log each fact as it is stored")
    .option("--max-sessions <n>", "Limit sessions to process (for cost control)", "0")
    .option("--max-session-tokens <n>", "Max tokens per session chunk; oversized sessions are split into overlapping chunks (default: batch limit)", "0")
    .action(withExit(async (opts: { dryRun?: boolean; all?: boolean; days?: string; since?: string; model?: string; verbose?: boolean; maxSessions?: string; maxSessionTokens?: string }) => {
      const sink = { log: (s: string) => console.log(s), warn: (s: string) => console.warn(s) };
      const maxSessions = Math.max(0, parseInt(opts.maxSessions || "0") || 0);
      const maxSessionTokens = Math.max(0, parseInt(opts.maxSessionTokens || "0") || 0);
      const days = opts.days != null ? parseInt(opts.days, 10) : undefined;
      const result = await runDistill(
        {
          dryRun: !!opts.dryRun,
          all: !!opts.all,
          days: Number.isFinite(days) ? days : undefined,
          since: opts.since?.trim() || undefined,
          model: opts.model,
          verbose: !!opts.verbose,
          maxSessions: maxSessions > 0 ? maxSessions : undefined,
          maxSessionTokens: maxSessionTokens > 0 ? maxSessionTokens : undefined,
        },
        sink,
      );
      if (result.dryRun) {
        console.log(`\nWould extract ${result.factsExtracted} facts from ${result.sessionsScanned} sessions.`);
      } else {
        console.log(
          `\nDistill done: ${result.stored} stored, ${result.skipped} skipped (${result.factsExtracted} extracted from ${result.sessionsScanned} sessions).`,
        );
      }
    }));

  mem
    .command("distill-window")
    .description("Print the session distillation window (full or incremental). Use at start of a distillation job to decide what to process; end the job with record-distill.")
    .option("--json", "Output machine-readable JSON only (mode, startDate, endDate, mtimeDays)")
    .action(withExit(async (opts: { json?: boolean }) => {
      const result = await runDistillWindow({ json: !!opts.json });
      if (opts.json) {
        console.log(JSON.stringify(result));
        return;
      }
      console.log(`Distill window: ${result.mode}`);
      console.log(`  startDate: ${result.startDate}`);
      console.log(`  endDate: ${result.endDate}`);
      console.log(`  mtimeDays: ${result.mtimeDays} (use find ... -mtime -${result.mtimeDays} for session files)`);
      console.log("Process sessions from that window; then run: openclaw hybrid-mem record-distill");
    }));

  mem
    .command("record-distill")
    .description("Record that session distillation was run (writes timestamp to .distill_last_run for 'verify' to show)")
    .action(withExit(async () => {
      const result = await runRecordDistill();
      console.log(`Recorded distillation run: ${result.timestamp}`);
      console.log(`Written to ${result.path}. Run 'openclaw hybrid-mem verify' to see it.`);
    }));

  mem
    .command("extract-daily")
    .description("Extract structured facts from daily memory files")
    .option("--days <n>", "How many days back to scan", "7")
    .option("--dry-run", "Show extractions without storing")
    .action(withExit(async (opts: { days: string; dryRun?: boolean }) => {
      const daysBack = parseInt(opts.days);
      const result = await runExtractDaily(
        { days: daysBack, dryRun: !!opts.dryRun },
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
    }));

  mem
    .command("extract-procedures")
    .description("Procedural memory: extract tool-call sequences from session JSONL and store as procedures")
    .option("--dir <path>", "Session directory (default: config procedures.sessionsDir)")
    .option("--days <n>", "Only sessions modified in last N days (default: all in dir)", "")
    .option("--dry-run", "Show what would be stored without writing")
    .action(withExit(async (opts: { dir?: string; days?: string; dryRun?: boolean }) => {
      const days = opts.days != null ? parseInt(opts.days, 10) : undefined;
      const result = await runExtractProcedures({
        sessionDir: opts.dir,
        days: Number.isFinite(days) ? days : undefined,
        dryRun: !!opts.dryRun,
      });
      if (result.dryRun) {
        console.log(`\n[dry-run] Sessions scanned: ${result.sessionsScanned}, procedures that would be stored: ${result.proceduresStored} (${result.positiveCount} positive, ${result.negativeCount} negative)`);
      } else {
        console.log(
          `\nSessions scanned: ${result.sessionsScanned}; procedures stored/updated: ${result.proceduresStored} (${result.positiveCount} positive, ${result.negativeCount} negative)`,
        );
      }
    }));

  mem
    .command("generate-auto-skills")
    .description("Generate SKILL.md + recipe.json in skills/auto/ for procedures validated enough times")
    .option("--dry-run", "Show what would be generated without writing")
    .action(withExit(async (opts: { dryRun?: boolean }) => {
      const result = await runGenerateAutoSkills({ dryRun: !!opts.dryRun });
      if (result.dryRun) {
        console.log(`\n[dry-run] Would generate ${result.generated} auto-skills`);
      } else {
        console.log(`\nGenerated ${result.generated} auto-skills${result.skipped > 0 ? ` (${result.skipped} skipped)` : ""}`);
        for (const p of result.paths) console.log(`  ${p}`);
      }
    }));

  mem
    .command("generate-proposals")
    .description("Generate persona proposals from reflection insights (patterns, rules, meta). Use after reflect-meta.")
    .option("--dry-run", "Show what would be proposed without creating")
    .option("--verbose", "Log each proposal created")
    .action(withExit(async (opts?: { dryRun?: boolean; verbose?: boolean }) => {
      if (!runGenerateProposals) {
        console.log("Generate-proposals not available (personaProposals disabled).");
        return;
      }
      const result = await runGenerateProposals({ dryRun: !!opts?.dryRun, verbose: !!opts?.verbose });
      if (opts?.dryRun) {
        console.log(`\n[dry-run] Would create ${result.created} proposal(s).`);
      } else {
        console.log(`\nCreated ${result.created} proposal(s).`);
      }
    }));

  mem
    .command("extract-directives")
    .description("Extract directive incidents from session JSONL (10 categories)")
    .option("--days <n>", "Scan sessions from last N days (default: 3)", "3")
    .option("--verbose", "Log each directive as it is detected")
    .option("--dry-run", "Show what would be extracted without storing")
    .action(withExit(async (opts: { days?: string; verbose?: boolean; dryRun?: boolean }) => {
      const days = parseInt(opts.days ?? "3", 10);
      const result = await runExtractDirectives({ days, verbose: opts.verbose, dryRun: opts.dryRun });
      console.log(`\nSessions scanned: ${result.sessionsScanned}; directives found: ${result.incidents.length}`);
      if (opts.dryRun) {
        console.log(`[dry-run] Would store ${result.incidents.length} directives as facts.`);
      } else {
        const stored = result.stored ?? result.incidents.length;
        const skipped = result.incidents.length - stored;
        console.log(`Stored ${stored} directives as facts${skipped > 0 ? ` (${skipped} duplicates skipped)` : ""}.`);
      }
    }));

  mem
    .command("extract-reinforcement")
    .description("Extract reinforcement incidents from session JSONL and annotate facts/procedures")
    .option("--days <n>", "Scan sessions from last N days (default: 3)", "3")
    .option("--verbose", "Log each reinforcement as it is detected")
    .option("--dry-run", "Show what would be annotated without storing")
    .action(withExit(async (opts: { days?: string; verbose?: boolean; dryRun?: boolean }) => {
      const days = parseInt(opts.days ?? "3", 10);
      const result = await runExtractReinforcement({ days, verbose: opts.verbose, dryRun: opts.dryRun });
      console.log(`\nSessions scanned: ${result.sessionsScanned}; reinforcement incidents found: ${result.incidents.length}`);
      if (opts.dryRun) {
        console.log(`[dry-run] Would annotate facts/procedures with reinforcement data.`);
      } else {
        const factsReinforced = result.incidents.reduce((sum, i) => sum + i.recalledMemoryIds.length, 0);
        console.log(`Annotated ${factsReinforced} facts with reinforcement data.`);
      }
    }));
}
