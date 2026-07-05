/**
 * Maintenance orchestrator CLI: cycle, nightly, full, steps.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readStepGuardTimestampMs, stepGuardEligible } from "../../../services/cron-guard.js";
import {
  effectiveCadenceLabel,
  formatMaintenanceSummary,
  listMaintenanceSteps,
  resolveStepGuardIntervalMs,
  runMaintenanceOrchestrator,
  toOrchestratorRunSummary,
} from "../../../services/maintenance-orchestrator.js";
import { atomicWriteFile } from "../../../utils/atomic-write.js";
import { formatTimestampUtcFromMs } from "../../../utils/dates.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";
import { buildCliMaintenanceRunners } from "./maintenance-step-runners.js";

function parseStepList(raw?: string): string[] | undefined {
  if (!raw?.trim()) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function registerMaintenanceOrchestratorCommands(maintenance: Chainable, b: ManageBindings): void {
  const openclawDir = join(homedir(), ".openclaw");

  const runTier = async (
    tiers: Array<"cycle" | "nightly">,
    opts?: {
      dryRun?: boolean;
      force?: boolean;
      full?: boolean;
      verbose?: boolean;
      include?: string;
      exclude?: string;
      maxRuntimeMin?: string;
      json?: boolean;
      summaryOut?: string;
      allowSkip?: boolean;
    },
  ) => {
    const verbose = !!opts?.verbose;
    const runStartedMs = Date.now();
    const runStartedIso = new Date(runStartedMs).toISOString();
    if (process.env.HM_RUN_ID) {
      process.env.HM_ORCHESTRATOR_RUN_ID = process.env.HM_RUN_ID;
    }
    const memoryDir = b.resolvedSqlitePath ? dirname(b.resolvedSqlitePath) : join(homedir(), ".openclaw", "memory");
    const backfillMarker = join(memoryDir, ".backfill-decay-done");
    const runners = buildCliMaintenanceRunners(b, {
      verbose,
      backfillDecayMarker: backfillMarker,
      scanOverrides: { force: opts?.force, full: opts?.full },
    });
    // `> 0` (not just finite) — "0" is a truthy, finite string that would otherwise produce a
    // zero-minute budget, which the orchestrator's `elapsed >= maxRuntimeMs` check treats as
    // already-exceeded before the first step runs, deferring every step including the one the
    // operator asked for. Treat a non-positive value the same as "no budget", consistent with
    // guardIntervalMs <= 0 meaning "always eligible" elsewhere in this file.
    const parsedMaxRuntimeMin = opts?.maxRuntimeMin ? Number(opts.maxRuntimeMin) : undefined;
    const maxRuntimeMs =
      parsedMaxRuntimeMin !== undefined && Number.isFinite(parsedMaxRuntimeMin) && parsedMaxRuntimeMin > 0
        ? parsedMaxRuntimeMin * 60_000
        : undefined;

    const isJsonMode = opts?.json || !!opts?.summaryOut?.trim() || !!process.env.HM_SUMMARY?.trim();
    const log = isJsonMode ? (m: string) => console.error(m) : (m: string) => console.log(m);
    const warn = (m: string) => console.error(m);

    const result = await runMaintenanceOrchestrator(
      {
        cfg: b.cfg,
        runners,
        openclawDir,
        logger: { info: log, warn },
        oneTimeMarkerExists: (path) => existsSync(join(memoryDir, path)),
        journalDb: b.factsDb.getRawDb(),
      },
      {
        tiers,
        dryRun: opts?.dryRun,
        force: opts?.force || opts?.full,
        verbose,
        include: parseStepList(opts?.include),
        exclude: parseStepList(opts?.exclude),
        maxRuntimeMs,
      },
    );

    const orchestratorSummary = toOrchestratorRunSummary(result, {
      runId: result.runId,
      job: process.env.HM_JOB,
      startedAt: result.startedAt ?? runStartedIso,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs ?? Date.now() - runStartedMs,
    });

    const summaryOutPath = opts?.summaryOut?.trim() || process.env.HM_SUMMARY?.trim();
    if (summaryOutPath) {
      atomicWriteFile(summaryOutPath, `${JSON.stringify(orchestratorSummary, null, 2)}\n`);
    }

    if (opts?.json) {
      console.log(JSON.stringify(orchestratorSummary, null, 2));
    } else {
      const { summaryLine, lines } = formatMaintenanceSummary(result.tierLabel, result.steps);
      console.log(summaryLine);
      for (const line of lines) console.log(line);
    }
    if (result.exitCode !== 0) process.exitCode = result.exitCode;

    // An explicit, forced --include run (whether via the dedicated `step <name>` command or
    // `cycle`/`nightly`/`full --include x,y --force`) is a targeted "run this now and verify it"
    // diagnostic — computeExitCode() treats "skipped" as benign because it's normal cadence-guard
    // behavior in an ordinary full/nightly run, so it doesn't cover "the step(s) I explicitly asked
    // for didn't execute" (#2031). Scoped to include+force so ordinary unforced --include automation
    // (which can legitimately skip by cadence) keeps its existing exit-0-on-skip behavior.
    const includeNames = parseStepList(opts?.include);
    if ((opts?.force || opts?.full) && includeNames?.length && !opts?.allowSkip) {
      // Look up each requested name individually rather than filtering result.steps down to the
      // matches — a name that belongs to a tier not requested (e.g. `cycle --include <nightly-step>
      // --force`) or that --exclude also removed never produces a step result at all, so it would
      // otherwise vanish from `selected` entirely and slip past the "every(...)" check below with a
      // false "didn't run" report never firing (an even quieter version of the bug #2031 closes).
      const requested = includeNames.map((name) => ({ name, result: result.steps.find((s) => s.name === name) }));
      const didNotRun = requested.every((r) => !r.result || r.result.status.startsWith("skipped"));
      if (didNotRun) {
        const detail = requested
          .map((r) =>
            r.result
              ? `${r.name}: ${r.result.status} — ${r.result.summary}`
              : `${r.name}: no result (wrong tier, excluded, or unregistered runner)`,
          )
          .join("; ");
        console.error(
          `maintenance ${result.tierLabel}: selected step(s) did not run (${detail}). ` +
            "Pass --allow-skip to treat this as a non-strict status check.",
        );
        if (!process.exitCode) process.exitCode = 3;
      }
    }

    return result;
  };

  const commonOptions = (cmd: Chainable) =>
    cmd
      .option("--dry-run", "List steps and guard status without executing")
      .option("--force", "Bypass per-step guards and scan watermarks (not feature gates)")
      .option("--full", "Alias for --force")
      .option("-v, --verbose", "Detailed per-step output")
      .option("--include <steps>", "Comma-separated step names to run only")
      .option("--exclude <steps>", "Comma-separated step names to skip")
      .option("--max-runtime-min <n>", "Optional time budget in minutes")
      .option("--json", "Emit orchestrator run summary as JSON")
      .option("--summary-out <path>", "Write orchestrator run summary JSON to path")
      .option(
        "--allow-skip",
        "With --include --force: exit 0 even if the selected step(s) didn't execute (locked/gated/guarded)",
      );

  commonOptions(
    maintenance
      .command("cycle")
      .description("Run cycle-tier maintenance steps (local gateway-native work)")
      .action(
        withExit(async (opts, cmd?: CommanderOptsParent) => {
          await runTier(["cycle"], { ...opts, verbose: !!opts?.verbose || readHybridMemVerbose(cmd) });
        }),
      ),
  );

  commonOptions(
    maintenance
      .command("nightly")
      .description("Run all non-cycle steps (staggered guards decide which execute)")
      .action(
        withExit(async (opts, cmd?: CommanderOptsParent) => {
          await runTier(["nightly"], { ...opts, verbose: !!opts?.verbose || readHybridMemVerbose(cmd) });
        }),
      ),
  );

  commonOptions(
    maintenance
      .command("full")
      .description("Run cycle + nightly tiers in sequence")
      .action(
        withExit(async (opts, cmd?: CommanderOptsParent) => {
          await runTier(["cycle", "nightly"], { ...opts, verbose: !!opts?.verbose || readHybridMemVerbose(cmd) });
        }),
      ),
  );

  // `maintenance step <name>` runs exactly one named step in isolation (#2028). Named `step` (singular)
  // to avoid colliding with the `maintenance run` JobRun-inspection group and the `steps` list command.
  //
  // Bounded by default (#2032): this command is meant for isolated diagnostic/verification runs, so
  // unlike cycle/nightly/full it caps runtime unless the operator overrides --max-runtime-min. Long
  // CPU/LLM-bound steps (e.g. passive-observer scanning a large first-run backlog) already consult the
  // orchestrator-wide deadline between sessions/chunks, so this cap actually bounds wall-clock time.
  const DEFAULT_STEP_MAX_RUNTIME_MIN = "15";

  commonOptions(
    maintenance
      .command("step <step>")
      .description(
        "Run exactly one named maintenance step in isolation (bypasses that step's cadence guard). Use `maintenance steps` to list valid names.",
      ),
  ).action(
    withExit(async (step: string, opts, cmd?: CommanderOptsParent) => {
      const stepName = step?.trim();
      const validNames = listMaintenanceSteps().map((s) => s.name);
      if (!stepName || !validNames.includes(stepName)) {
        console.error(`Unknown maintenance step: ${stepName || "(none)"}`);
        console.error(`Valid steps (${validNames.length}):`);
        for (const name of validNames) console.error(`  ${name}`);
        process.exitCode = 1;
        return;
      }
      // Force so the targeted step actually runs even if its cadence guard has not expired (this
      // command is an explicit "run this step now" diagnostic). include=[step] across both tiers
      // means the orchestrator executes ONLY that step and no unrelated stages (#2028). runTier()
      // itself checks whether this forced, explicitly-included step actually executed (#2031).
      await runTier(["cycle", "nightly"], {
        ...opts,
        include: stepName,
        force: true,
        maxRuntimeMin: opts?.maxRuntimeMin ?? DEFAULT_STEP_MAX_RUNTIME_MIN,
        verbose: !!opts?.verbose || readHybridMemVerbose(cmd),
      });
    }),
  );

  maintenance
    .command("steps")
    .description("List registered maintenance steps with tier, guard interval, and cadence")
    .option("--json", "Output JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const rows = listMaintenanceSteps().map((step) => {
          const guardMs = resolveStepGuardIntervalMs(step, b.cfg);
          const guard = stepGuardEligible(step.name, guardMs, openclawDir);
          return {
            name: step.name,
            tier: step.tier,
            guardIntervalMs: guardMs,
            cadence: effectiveCadenceLabel(guardMs),
            llmTier: step.llmTier,
            dependsOn: step.dependsOn ?? [],
            featureGate: step.featureGate ? step.featureGate(b.cfg) : true,
            lastRunAt: guard.lastRunMs ? formatTimestampUtcFromMs(guard.lastRunMs) : null,
            nextEligibleAt: guard.nextEligibleMs ? formatTimestampUtcFromMs(guard.nextEligibleMs) : null,
            eligibleNow: guard.eligible,
          };
        });
        if (opts?.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        console.log(`Maintenance steps (${rows.length} registered):`);
        for (const row of rows) {
          const gate = row.featureGate ? "" : " [gate:off]";
          console.log(
            `  ${row.name.padEnd(28)} ${row.tier.padEnd(8)} ${row.cadence.padEnd(18)} llm=${row.llmTier}${gate}${row.eligibleNow ? " *due*" : ""}`,
          );
        }
      }),
    );
}
