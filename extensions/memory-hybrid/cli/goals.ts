/**
 * CLI: hybrid-mem goals — list, status, cancel, stewardship-run
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { HybridMemoryConfig } from "../config.js";
import {
  listGoals,
  resolveGoalId,
  resolveGoalsDir,
  runGoalHealthCheck,
  terminateGoal,
} from "../services/goal-stewardship.js";
import { getEnv } from "../utils/env-manager.js";
import type { Chainable } from "./shared.js";

function workspaceRoot(): string {
  return getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
}

function goalsDir(cfg: HybridMemoryConfig): string {
  return resolveGoalsDir(workspaceRoot(), cfg.goalStewardship.goalsDir);
}

export function registerGoalCommands(mem: Chainable, ctx: { cfg: HybridMemoryConfig }): void {
  const g = mem
    .command("goals")
    .description("Goal stewardship: list and manage tracked goals (see docs/GOAL-STEWARDSHIP-DESIGN.md)");

  g.command("list")
    .description("List goals")
    .option("--all", "include terminal goals")
    .action(async (opts: { all?: boolean }) => {
      const dir = goalsDir(ctx.cfg);
      const goals = await listGoals(dir);
      const rows = opts.all ? goals : goals.filter((x) => !["completed", "failed", "abandoned"].includes(x.status));
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
    .action(async (idOrLabel: string) => {
      const dir = goalsDir(ctx.cfg);
      const goal = await resolveGoalId(dir, idOrLabel);
      if (!goal) {
        console.error("Goal not found.");
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(goal, null, 2));
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
