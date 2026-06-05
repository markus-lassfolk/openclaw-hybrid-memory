/**
 * CLI registration: run-all (orchestrator alias) + agents health/activity.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mergeAgentHealthDashboard } from "../../../backends/agent-health-store.js";
import { collectForgeState } from "../../../routes/dashboard-server.js";
import { formatMaintenanceSummary, runMaintenanceOrchestrator } from "../../../services/maintenance-orchestrator.js";
import { formatTimestampUtcFromMs } from "../../../utils/dates.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
import { registerScanMaintenanceOverrideOptions } from "../../maintenance-overrides.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";
import { buildCliMaintenanceRunners } from "./maintenance-step-runners.js";

export function registerRunAllCommand(mem: Chainable, b: ManageBindings, commandName = "run-all"): void {
  registerScanMaintenanceOverrideOptions(
    mem
      .command(commandName)
      .description(
        "Run all maintenance tiers via the orchestrator (alias for `maintenance full`). Use --dry-run to list steps.",
      )
      .option("--dry-run", "List steps that would run without executing")
      .option("-v, --verbose", "Show detailed output for each step"),
  ).action(
    withExit(
      async (
        opts?: { dryRun?: boolean; verbose?: boolean; force?: boolean; full?: boolean },
        cmd?: CommanderOptsParent,
      ) => {
        const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
        const memoryDir = b.resolvedSqlitePath ? dirname(b.resolvedSqlitePath) : join(homedir(), ".openclaw", "memory");
        const openclawDir = join(homedir(), ".openclaw");
        const runners = buildCliMaintenanceRunners(b, {
          verbose,
          backfillDecayMarker: join(memoryDir, b.BACKFILL_DECAY_MARKER),
          scanOverrides: { force: opts?.force, full: opts?.full },
        });
        const result = await runMaintenanceOrchestrator(
          {
            cfg: b.cfg,
            runners,
            openclawDir,
            logger: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
            oneTimeMarkerExists: (path) => existsSync(join(memoryDir, path)),
          },
          {
            tiers: ["cycle", "nightly"],
            dryRun: opts?.dryRun,
            force: opts?.force || opts?.full,
            verbose,
          },
        );
        const { summaryLine, lines } = formatMaintenanceSummary(result.tierLabel, result.steps);
        console.log(summaryLine);
        for (const line of lines) console.log(line);
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
      },
    ),
  );
}

export function registerManageAgentsAuditRunall(mem: Chainable, b: ManageBindings): void {
  const { agentHealthStore, auditStore } = b;

  const agentsCmd = mem.command("agents").description("Multi-agent health (Issue #789)");
  agentsCmd
    .command("health")
    .description("Show per-agent health (SQLite + Forge live state)")
    .option("--agent <id>", "Filter to a single agent id")
    .action(
      withExit(async (opts?: { agent?: string }) => {
        if (!agentHealthStore) {
          console.error("Agent health store is not available.");
          process.exitCode = 1;
          return;
        }
        const forge = await collectForgeState();
        const views = mergeAgentHealthDashboard(forge, agentHealthStore.listAll());
        const filter = opts?.agent?.trim().toLowerCase();
        let any = false;
        for (const v of views) {
          if (filter && v.agentId !== filter) continue;
          any = true;
          console.log(
            `${v.agentId}\t${v.status}\tscore=${v.score.toFixed(1)}\tlast=${formatTimestampUtcFromMs(v.lastSeen)}\t${v.lastTask.slice(0, 120)}`,
          );
        }
        if (!any) {
          console.log("(no rows)");
        }
      }),
    );
  agentsCmd
    .command("activity")
    .description("Recent audit events for an agent (requires audit log)")
    .requiredOption("--agent <id>", "Agent id")
    .option("--hours <n>", "Lookback hours", "24")
    .action(
      withExit(async (opts?: { agent?: string; hours?: string }) => {
        if (!auditStore) {
          console.error("Audit store is not available.");
          process.exitCode = 1;
          return;
        }
        const agent = opts?.agent?.trim();
        if (!agent) {
          console.error("--agent is required.");
          process.exitCode = 1;
          return;
        }
        const hours = Math.max(1, Math.min(720, Number.parseInt(String(opts?.hours ?? "24"), 10) || 24));
        const sinceMs = Date.now() - hours * 3600 * 1000;
        const rows = auditStore.query({ sinceMs, agentId: agent, limit: 200 });
        for (const r of rows) {
          const ts = formatTimestampUtcFromMs(r.timestamp);
          console.log(`${ts}\t${r.action}\t${r.outcome}\t${r.target ?? ""}`);
        }
        if (rows.length === 0) {
          console.log("(no events)");
        }
      }),
    );
}
