/**
 * CLI: hybrid-mem goals — list, status, cancel, stewardship-run
 */
import { join } from "node:path";
import type { HybridMemoryConfig } from "../config.js";
import {
  listActiveGoals,
  listGoals,
  resolveGoalId,
  resolveGoalsDir,
  runGoalHealthCheck,
  terminateGoal,
  updateGoal,
} from "../services/goal-stewardship.js";
import { formatGoalStewardshipConfigLines, workspaceRootForCli } from "./config-feature-summaries.js";
import type { Chainable } from "./shared.js";

function workspaceRoot(): string {
  return workspaceRootForCli();
}

function goalsDir(cfg: HybridMemoryConfig): string {
  return resolveGoalsDir(workspaceRoot(), cfg.goalStewardship.goalsDir);
}

export function registerGoalCommands(mem: Chainable, ctx: { cfg: HybridMemoryConfig }): void {
  const g = mem
    .command("goals")
    .description("Goal stewardship: list and manage tracked goals (see docs/GOAL-STEWARDSHIP-DESIGN.md)");

  g.command("config")
    .description("Show goal stewardship settings from plugin config (same keys as openclaw.json)")
    .action(() => {
      for (const line of formatGoalStewardshipConfigLines(ctx.cfg.goalStewardship)) {
        console.log(line);
      }
    });

  g.command("list")
    .description("List goals")
    .option("--all", "include terminal goals")
    .option("--json", "output raw JSON array")
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const dir = goalsDir(ctx.cfg);
      const goals = await listGoals(dir);
      const rows = opts.all ? goals : goals.filter((x) => !["completed", "failed", "abandoned"].includes(x.status));
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("No goals.");
        return;
      }
      for (const x of rows) {
        console.log(
          `${x.label.padEnd(20)} ${x.status.padEnd(12)} ${x.priority}  assessments ${x.assessmentCount}/${x.maxAssessments}  dispatches ${x.dispatchCount}/${x.maxDispatches}`,
        );
      }
    });

  g.command("status <idOrLabel>")
    .description("Show goal detail")
    .option("--json", "output raw JSON")
    .action(async (idOrLabel: string, opts: { json?: boolean }) => {
      const dir = goalsDir(ctx.cfg);
      const goal = await resolveGoalId(dir, idOrLabel);
      if (!goal) {
        console.error("Goal not found.");
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(goal, null, 2));
        return;
      }
      const ago = (iso: string | null) => {
        if (!iso) return "never";
        const ms = Date.now() - Date.parse(iso);
        if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
        if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
        return `${Math.round(ms / 3_600_000)}h ago`;
      };
      console.log(`Goal: ${goal.label} (ID: ${goal.id})`);
      console.log(`Status:      ${goal.status}`);
      console.log(`Priority:    ${goal.priority}`);
      console.log(`Created:     ${goal.createdAt}`);
      console.log(`Last assessed: ${ago(goal.lastAssessedAt)}`);
      console.log(`Last dispatched: ${ago(goal.lastDispatchedAt)}`);
      console.log(
        `Assessments: ${goal.assessmentCount}/${goal.maxAssessments}  |  Dispatches: ${goal.dispatchCount}/${goal.maxDispatches}  |  Failures: ${goal.consecutiveFailures}`,
      );
      console.log(`\nDescription:\n  ${goal.description}`);
      console.log(`\nAcceptance Criteria:`);
      goal.acceptanceCriteria.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
      if (goal.linkedTasks.length > 0) {
        console.log(`\nLinked Tasks:`);
        goal.linkedTasks.forEach((t) =>
          console.log(`  ${t.label.padEnd(20)} ${t.status}${t.sessionKey ? `  session: ${t.sessionKey}` : ""}`),
        );
      }
      console.log(`\nBlockers: ${goal.currentBlockers.length > 0 ? goal.currentBlockers.join(", ") : "none"}`);
      const last10 = goal.history.slice(-10).reverse();
      if (last10.length > 0) {
        console.log(`\nHistory (last ${last10.length}):`);
        last10.forEach((h) =>
          console.log(`  ${h.timestamp}  ${h.actor.padEnd(8)}  ${h.action.padEnd(18)} "${h.detail.slice(0, 100)}"`),
        );
      }
    });

  g.command("cancel <idOrLabel>")
    .description("Abandon a goal")
    .requiredOption("--reason <text>", "reason")
    .action(async (idOrLabel: string, opts: { reason: string }) => {
      const dir = goalsDir(ctx.cfg);
      const goal = await resolveGoalId(dir, idOrLabel);
      if (!goal) {
        console.error("Goal not found.");
        process.exitCode = 1;
        return;
      }
      await terminateGoal(dir, goal.id, "abandoned", opts.reason, "user");
      console.log(`Abandoned ${goal.label}`);
    });

  g.command("audit")
    .description("Structured audit snapshot (JSON) for operators and automation")
    .option("--jsonl", "emit one JSON object per goal (NDJSON)")
    .action(async (opts: { jsonl?: boolean }) => {
      const dir = goalsDir(ctx.cfg);
      const goals = await listGoals(dir);
      const base = {
        generatedAt: new Date().toISOString(),
        goalsDir: dir,
        workspaceRoot: workspaceRoot(),
        configSnapshot: {
          enabled: ctx.cfg.goalStewardship.enabled,
          goalsDir: ctx.cfg.goalStewardship.goalsDir,
          heartbeatPatterns: ctx.cfg.goalStewardship.heartbeatPatterns,
          attentionWeights: ctx.cfg.goalStewardship.attentionWeights,
          multiGoalMaxChars: ctx.cfg.goalStewardship.multiGoalMaxChars,
          confirmationPolicy: ctx.cfg.goalStewardship.confirmationPolicy,
        },
      };
      if (opts.jsonl) {
        for (const goal of goals) {
          console.log(JSON.stringify({ ...base, goal }));
        }
        if (goals.length === 0) console.log(JSON.stringify({ ...base, goal: null }));
      } else {
        console.log(JSON.stringify({ ...base, goals }, null, 2));
      }
    });

  g.command("budget")
    .description("Show budget usage across all active goals and global limits")
    .action(async () => {
      const dir = goalsDir(ctx.cfg);
      const active = await listActiveGoals(dir);
      const gs = ctx.cfg.goalStewardship;
      const totalDispatches = active.reduce((s, g2) => s + g2.dispatchCount, 0);
      console.log("Goal Budget Status\n");
      console.log(
        `Global limits: ${gs.globalLimits.maxDispatchesPerHour} dispatches/hour (total: ${totalDispatches}), max ${gs.globalLimits.maxActiveGoals} active goals (active: ${active.length})\n`,
      );
      if (active.length === 0) {
        console.log("  No active goals.");
      } else {
        for (const a of active) {
          const dPct = a.maxDispatches > 0 ? Math.round((a.dispatchCount / a.maxDispatches) * 100) : 0;
          const aPct = a.maxAssessments > 0 ? Math.round((a.assessmentCount / a.maxAssessments) * 100) : 0;
          console.log(
            `  ${a.label.padEnd(20)} dispatches: ${a.dispatchCount}/${a.maxDispatches} (${dPct}%)   assessments: ${a.assessmentCount}/${a.maxAssessments} (${aPct}%)`,
          );
        }
      }
    });

  g.command("reset-budget <idOrLabel>")
    .description("Reset dispatch/assessment counters for a goal")
    .action(async (idOrLabel: string) => {
      const dir = goalsDir(ctx.cfg);
      const goal = await resolveGoalId(dir, idOrLabel);
      if (!goal) {
        console.error("Goal not found.");
        process.exitCode = 1;
        return;
      }
      const prevDisp = goal.dispatchCount;
      const prevAssess = goal.assessmentCount;
      const wasBlocked = goal.status === "blocked";
      const patch: Record<string, unknown> = {
        dispatchCount: 0,
        assessmentCount: 0,
        consecutiveFailures: 0,
      };
      if (wasBlocked) {
        patch.status = "active";
        patch.currentBlockers = [];
      }
      await updateGoal(dir, goal.id, patch as Parameters<typeof updateGoal>[2], {
        timestamp: new Date().toISOString(),
        action: "budget-reset",
        detail: `dispatches ${prevDisp}->0, assessments ${prevAssess}->0${wasBlocked ? ", status blocked->active" : ""}`,
        actor: "user",
      });
      console.log(`Budget reset for ${goal.label}.`);
      console.log(`  dispatches: 0/${goal.maxDispatches} (was ${prevDisp}/${goal.maxDispatches})`);
      console.log(`  assessments: 0/${goal.maxAssessments} (was ${prevAssess}/${goal.maxAssessments})`);
      if (wasBlocked) console.log(`  status: active (was blocked)`);
    });

  g.command("stewardship-run")
    .description("Run one deterministic goal health check (same as plugin watchdog)")
    .action(async () => {
      if (!ctx.cfg.goalStewardship.enabled) {
        console.error("goalStewardship.enabled is false.");
        process.exitCode = 1;
        return;
      }
      const dir = goalsDir(ctx.cfg);
      const wr = workspaceRoot();
      const result = await runGoalHealthCheck({
        goalsDir: dir,
        cfg: { ...ctx.cfg.goalStewardship, watchdogHealthCheck: true },
        workspaceRoot: wr,
        logger: console,
      });
      console.log(`Checked ${result.goalsChecked}, updated ${result.goalsUpdated}`);
      for (const a of result.actions) {
        console.log(`  ${a.label}: ${a.action} — ${a.reason}`);
      }
    });
}
