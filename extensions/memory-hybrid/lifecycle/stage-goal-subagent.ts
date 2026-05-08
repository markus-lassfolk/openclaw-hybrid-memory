/**
 * Link subagent_spawned / subagent_ended to goal registry when goal stewardship is enabled.
 */
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { capturePluginError } from "../services/error-reporter.js";
import {
  type GoalSubagentSpawnEvent,
  linkSubagentToGoal,
  resolveGoalForSpawn,
  updateGoalOnSubagentEnd,
} from "../services/goal-stewardship.js";
import { type SubagentEndedEvent, subagentEndedIsSuccess } from "../utils/subagent-ended-utils.js";
import type { LifecycleContext } from "./types.js";

export function registerGoalSubagentHandlers(api: ClawdbotPluginApi, ctx: LifecycleContext, goalsDir: string): void {
  if (!ctx.cfg.goalStewardship.enabled) return;

  api.on("subagent_spawned", async (event: unknown) => {
    try {
      const ev = event as GoalSubagentSpawnEvent;
      const gid = await resolveGoalForSpawn(ev, goalsDir);
      if (!gid) return;
      const childOrSession = ev.childSessionKey ?? ev.sessionKey;
      const label = ev.label ?? childOrSession ?? `subagent-${Date.now()}`;
      await linkSubagentToGoal(goalsDir, gid, {
        label,
        sessionKey: childOrSession ?? null,
        status: "in_progress",
      });
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "goal-subagent",
        operation: "subagent_spawned",
      });
    }
  });

  api.on("subagent_ended", async (event: unknown) => {
    try {
      const ev = event as SubagentEndedEvent;
      const targetKey = ev.targetSessionKey ?? ev.sessionKey;
      const label = ev.label ?? (targetKey ? String(targetKey) : "");
      if (!label && !targetKey) return;
      const success = subagentEndedIsSuccess(ev);
      const outcome = ev.outcome ?? ev.error ?? ev.reason ?? null;
      await updateGoalOnSubagentEnd(goalsDir, {
        label: label || (targetKey as string),
        sessionKey: targetKey ?? null,
        success,
        outcome: outcome ? String(outcome) : null,
      });
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "goal-subagent",
        operation: "subagent_ended",
      });
    }
  });
}
