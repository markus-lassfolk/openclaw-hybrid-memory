import { capturePluginError } from "../services/error-reporter.js";
import { collectStatus } from "../routes/dashboard-server.js";
import { getDashboardUrl } from "./cmd-install.js";
import { type Chainable, withExit } from "./shared.js";

export type StatusContext = {
  factsDb: import("../backends/facts-db.js").FactsDB;
  vectorDb: import("../backends/vector-db.js").VectorDB;
  resolvedSqlitePath: string;
  resolvedLancePath: string;
  pluginId: string;
  cfg: Record<string, unknown>;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  costTracker?: import("../backends/cost-tracker.js").CostTracker | null;
  auditStore?: import("../backends/audit-store.js").AuditStore | null;
  agentHealthStore?: import("../backends/agent-health-store.js").AgentHealthStore | null;
};

export async function runStatusForCli(ctx: StatusContext, opts?: { format?: "text" | "json" }): Promise<void> {
  const status = await collectStatus({
    factsDb: ctx.factsDb,
    vectorDb: ctx.vectorDb,
    resolvedSqlitePath: ctx.resolvedSqlitePath,
    resolvedLancePath: ctx.resolvedLancePath,
    costTracker: ctx.costTracker ?? null,
    auditStore: ctx.auditStore ?? null,
    agentHealthStore: ctx.agentHealthStore ?? null,
    logger: ctx.logger,
  });
  const dashboardUrl = getDashboardUrl({
    plugins: {
      entries: {
        [ctx.pluginId]: {
          config: ctx.cfg,
        },
      },
    },
  });

  if (opts?.format === "json") {
    console.log(JSON.stringify({ dashboardUrl, status }, null, 2));
    return;
  }

  const needsAttention = status.cronJobs.filter(
    (job) => job.enabled && (job.consecutiveErrors > 0 || job.lastRunAt == null),
  );
  const auditFailureCount = status.audit.recentFailures.length;
  const agentAlerts = status.agentHealth.alerts.length;
  const activeTask = status.taskQueue.current;

  console.log("Hybrid Memory status");
  console.log(`Dashboard: ${dashboardUrl}`);
  console.log("");
  console.log("Memory");
  console.log(`  Active facts: ${status.memory.activeFacts.toLocaleString()}`);
  console.log(`  Expired facts: ${status.memory.expiredFacts.toLocaleString()}`);
  console.log(`  Vectors: ${status.memory.vectorCount.toLocaleString()}`);
  console.log(`  Total size: ${status.memory.totalSizeBytes.toLocaleString()} bytes`);
  console.log("");
  console.log("Health home");
  console.log(`  Cron jobs: ${status.cronJobs.length} total, ${needsAttention.length} needing attention`);
  console.log(`  Audit failures (24h): ${auditFailureCount}`);
  console.log(`  Agent alerts: ${agentAlerts}`);
  console.log(`  Current task: ${activeTask?.title ?? activeTask?.details ?? "none"}`);
  console.log("");
  console.log("What to do next");
  if (needsAttention.length > 0) {
    console.log(`  - Run \`openclaw hybrid-mem verify\`: ${needsAttention[0].name} still needs attention.`);
  }
  if (auditFailureCount > 0) {
    console.log("  - Open Mission Control to inspect the audit timeline.");
  }
  if (agentAlerts > 0) {
    console.log("  - Open Mission Control to inspect stale or degraded agents.");
  }
  if (needsAttention.length === 0 && auditFailureCount === 0 && agentAlerts === 0) {
    console.log("  - Everything looks healthy. Open Mission Control for deeper inspection.");
  }
}

export function registerStatusCommands(mem: Chainable, ctx: StatusContext): void {
  const command = mem.command("status").description("Unified health home: memory, jobs, audit, and dashboard link");
  if (command.alias) command.alias("home");
  command.option("--json", "Output the full status payload as JSON").action(
    withExit(async (opts?: { json?: boolean }) => {
      try {
        await runStatusForCli(ctx, { format: opts?.json ? "json" : "text" });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "cli",
          operation: "status",
        });
        throw err;
      }
    }),
  );

  const dashboard = mem.command("dashboard").description("Print the Mission Control dashboard URL");
  if (dashboard.alias) dashboard.alias("mission-control");
  dashboard.action(
    withExit(async () => {
      const url = getDashboardUrl({
        plugins: { entries: { [ctx.pluginId]: { config: ctx.cfg } } },
      });
      console.log(`Mission Control: ${url}`);
      console.log("The dashboard is served by the plugin when the OpenClaw gateway is running.");
      console.log("Tip: run `openclaw hybrid-mem status` for a quick health summary.");
    }),
  );
}
