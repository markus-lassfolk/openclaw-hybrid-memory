/**
 * Goal stewardship tools — see docs/GOAL-STEWARDSHIP-DESIGN.md
 */
import { Type } from "@sinclair/typebox";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { EventLog } from "../backends/event-log.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { stringEnum } from "../utils/typebox.js";
import {
  createGoal,
  goalStewardshipDefaultsFromConfig,
  isGlobalRateLimited,
  isTerminalStatus,
  listActiveGoals,
  resolveGoalId,
  terminateGoal,
  updateGoal,
  recordGoalDispatch,
  type GoalVerification,
} from "../services/goal-stewardship.js";
import { capturePluginError } from "../services/error-reporter.js";
import {
  circuitBreakerShortBlocker,
  composeCircuitBreakerHumanSummary,
  computeCircuitBreakerStateAfterAssess,
  evaluateCircuitBreakerTrip,
} from "../services/goal-circuit-breaker.js";
import type { GoalHistoryEntry } from "../services/goal-stewardship-types.js";

export interface GoalToolsContext {
  cfg: HybridMemoryConfig;
  goalsDir: string;
  workspaceRoot: string;
  /** Absolute path to ACTIVE-TASK.md (for task hygiene tools). */
  resolvedActiveTaskPath: string;
  factsDb: FactsDB | null;
  eventLog: EventLog | null;
  memoryDir: string;
}

const PRIORITIES = ["critical", "high", "normal", "low"] as const;

async function flushGoalOutcomeToMemory(memoryDir: string, title: string, lines: string[]): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const filePath = join(memoryDir, `${date}.md`);
  await mkdir(memoryDir, { recursive: true });
  const block = ["", `## ${title} — ${date}`, "", ...lines, ""].join("\n");
  await appendFile(filePath, block, "utf-8").catch((err) => {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "goal-tools",
      operation: "flushGoalOutcomeToMemory",
    });
  });
}

export function registerGoalTools(ctx: GoalToolsContext, api: ClawdbotPluginApi): void {
  const { cfg, goalsDir, factsDb, eventLog, memoryDir } = ctx;
  const gs = cfg.goalStewardship;
  const defaults = goalStewardshipDefaultsFromConfig(gs);
  const notEnabled = () => ({
    content: [
      {
        type: "text" as const,
        text: "Goal stewardship is disabled. Set goalStewardship.enabled: true in plugin config.",
      },
    ],
    details: { error: "goal_stewardship_disabled" },
  });

  api.registerTool(
    {
      name: "goal_register",
      label: "Register Goal",
      description: "Register a long-running goal with acceptance criteria.",
      parameters: Type.Object({
        label: Type.String(),
        description: Type.String(),
        acceptance_criteria: Type.Array(Type.String(), { minItems: 1 }),
        priority: Type.Optional(stringEnum(PRIORITIES as unknown as readonly string[])),
        verification_type: Type.Optional(
          stringEnum(["manual", "file_exists", "command_exit_zero", "pr_merged", "http_ok"] as const),
        ),
        verification_target: Type.Optional(Type.String()),
        max_dispatches: Type.Optional(Type.Number()),
        max_assessments: Type.Optional(Type.Number()),
        cooldown_minutes: Type.Optional(Type.Number()),
        confirmed: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!gs.enabled) return notEnabled();
        try {
          const active = await listActiveGoals(goalsDir);
          if (active.length >= gs.globalLimits.maxActiveGoals) {
            return {
              content: [{ type: "text", text: `Max active goals (${gs.globalLimits.maxActiveGoals}) reached.` }],
              details: { error: "max_active_goals" },
            };
          }
          const p = params as {
            label: string;
            description: string;
            acceptance_criteria: string[];
            priority?: (typeof PRIORITIES)[number];
            verification_type?: GoalVerification["type"];
            verification_target?: string;
            max_dispatches?: number;
            max_assessments?: number;
            cooldown_minutes?: number;
            confirmed?: boolean;
          };
          const effectivePriority = p.priority ?? defaults.priority;
          if (
            gs.confirmationPolicy.requireRegisterAckForPriorities.includes(effectivePriority) &&
            p.confirmed !== true
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: `Priority "${effectivePriority}" requires explicit human confirmation. Ask the user to approve these criteria, then call goal_register again with confirmed: true.`,
                },
              ],
              details: { error: "confirmation_required", priority: effectivePriority },
            };
          }
          let verification: GoalVerification | undefined;
          if (p.verification_type && p.verification_target) {
            verification = { type: p.verification_type, target: p.verification_target };
          }
          const goal = await createGoal(
            goalsDir,
            {
              label: p.label,
              description: p.description,
              acceptanceCriteria: p.acceptance_criteria,
              priority: p.priority,
              verification,
              maxDispatches: p.max_dispatches,
              maxAssessments: p.max_assessments,
              cooldownMinutes: p.cooldown_minutes,
            },
            defaults,
            eventLog,
          );
          return {
            content: [{ type: "text", text: `Goal registered: ${goal.label} (${goal.id})` }],
            details: { goal },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "goal-tools",
            operation: "goal_register",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "goal_register" },
  );

  api.registerTool(
    {
      name: "goal_assess",
      label: "Assess Goal",
      description: "Record a stewardship assessment.",
      parameters: Type.Object({
        goal_id: Type.String(),
        assessment: Type.String(),
        next_action: Type.String(),
        blockers: Type.Optional(Type.Array(Type.String())),
        dispatched: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!gs.enabled) return notEnabled();
        try {
          const p = params as {
            goal_id: string;
            assessment: string;
            next_action: string;
            blockers?: string[];
            dispatched?: boolean;
          };
          const goal = await resolveGoalId(goalsDir, p.goal_id);
          if (!goal) return { content: [{ type: "text", text: "Goal not found." }], details: { error: "not_found" } };
          if (isTerminalStatus(goal.status)) {
            return { content: [{ type: "text", text: `Goal already ${goal.status}` }], details: { error: "terminal" } };
          }
          if (goal.assessmentCount >= goal.maxAssessments) {
            await updateGoal(
              goalsDir,
              goal.id,
              { status: "blocked", currentBlockers: ["Assessment budget exhausted"] },
              { timestamp: new Date().toISOString(), action: "blocked", detail: "assessments", actor: "steward" },
            );
            return { content: [{ type: "text", text: "Assessment budget exhausted." }], details: { error: "budget" } };
          }
          const ts = new Date().toISOString();
          let dispatchCount = goal.dispatchCount;
          let lastDispatchedAt = goal.lastDispatchedAt;
          if (p.dispatched) {
            if (isGlobalRateLimited(gs.globalLimits.maxDispatchesPerHour)) {
              return {
                content: [{ type: "text", text: "Global dispatch rate limit reached." }],
                details: { error: "rate_limited" },
              };
            }
            if (goal.dispatchCount >= goal.maxDispatches) {
              return {
                content: [{ type: "text", text: "Dispatch budget exhausted." }],
                details: { error: "dispatch_budget" },
              };
            }
            recordGoalDispatch();
            dispatchCount += 1;
            lastDispatchedAt = ts;
          }
          const blockersExplicitlyProvided = p.blockers !== undefined;
          const newBlockers = blockersExplicitlyProvided ? p.blockers! : goal.currentBlockers;
          const newAssessmentCount = goal.assessmentCount + 1;
          const cbState = blockersExplicitlyProvided
            ? computeCircuitBreakerStateAfterAssess(goal, newBlockers, newAssessmentCount)
            : {
                lastBlockerFingerprint: goal.lastBlockerFingerprint,
                sameBlockerStreak: goal.sameBlockerStreak,
                circuitBreakerLastProgressAssessmentCount: goal.circuitBreakerLastProgressAssessmentCount,
              };
          const tripEval = evaluateCircuitBreakerTrip(gs.circuitBreaker, cbState, newAssessmentCount);

          const basePatch = {
            assessmentCount: newAssessmentCount,
            lastAssessedAt: ts,
            dispatchCount,
            lastDispatchedAt,
            lastOutcome: p.assessment,
            currentBlockers: newBlockers,
            ...cbState,
          };

          const assessEntry: GoalHistoryEntry = {
            timestamp: ts,
            action: "assessed",
            detail: `${p.assessment.slice(0, 400)} | next: ${p.next_action.slice(0, 100)}`,
            actor: "steward",
          };

          if (tripEval.trip) {
            const goalPreview = {
              ...goal,
              ...basePatch,
              currentBlockers: newBlockers,
            };
            const summary = composeCircuitBreakerHumanSummary(goalPreview, tripEval.reason, gs.circuitBreaker);
            const blockedPatch = {
              ...basePatch,
              status: "blocked" as const,
              currentBlockers: [circuitBreakerShortBlocker(tripEval.reason)],
              humanEscalationSummary: summary,
              escalationKind: "circuit_breaker" as const,
              lastOutcome: circuitBreakerShortBlocker(tripEval.reason),
            };
            const cbEntry: GoalHistoryEntry = {
              timestamp: ts,
              action: "circuit_breaker",
              detail: summary.slice(0, 8000),
              actor: "watchdog",
            };
            const updated = await updateGoal(goalsDir, goal.id, blockedPatch, [assessEntry, cbEntry]);
            try {
              eventLog?.append({
                sessionId: "goal-stewardship",
                timestamp: ts,
                eventType: "action_taken",
                content: {
                  kind: "goal.circuit_breaker",
                  goalId: updated.id,
                  label: updated.label,
                  reason: tripEval.reason,
                },
              });
            } catch {
              /* */
            }
            if (gs.circuitBreaker.appendMemoryEscalation) {
              await flushGoalOutcomeToMemory(memoryDir, `Circuit breaker: ${updated.label}`, [
                "**Summary:**",
                "",
                ...summary.split("\n"),
              ]);
            }
            return {
              content: [
                {
                  type: "text",
                  text: `Circuit breaker: ${updated.label} is blocked — human escalation required. See goal JSON (humanEscalationSummary) or workspace memory/.`,
                },
              ],
              details: { goal: updated, circuitBreaker: tripEval.reason },
            };
          }

          const updated = await updateGoal(goalsDir, goal.id, basePatch, assessEntry);
          try {
            eventLog?.append({
              sessionId: "goal-stewardship",
              timestamp: ts,
              eventType: "action_taken",
              content: { kind: "goal.assessed", goalId: updated.id, label: updated.label },
            });
          } catch {
            /* */
          }
          return {
            content: [{ type: "text", text: `Assessed ${updated.label}. Next: ${p.next_action}` }],
            details: { goal: updated },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "goal-tools",
            operation: "goal_assess",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "goal_assess" },
  );

  api.registerTool(
    {
      name: "goal_update",
      label: "Update Goal",
      parameters: Type.Object({
        goal_id: Type.String(),
        description: Type.Optional(Type.String()),
        acceptance_criteria: Type.Optional(Type.Array(Type.String())),
        priority: Type.Optional(stringEnum(PRIORITIES as unknown as readonly string[])),
        note: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!gs.enabled) return notEnabled();
        const p = params as {
          goal_id: string;
          description?: string;
          acceptance_criteria?: string[];
          priority?: (typeof PRIORITIES)[number];
          note?: string;
        };
        const goal = await resolveGoalId(goalsDir, p.goal_id);
        if (!goal) return { content: [{ type: "text", text: "Goal not found." }], details: { error: "not_found" } };
        const patch: Parameters<typeof updateGoal>[2] = {};
        if (p.description !== undefined) patch.description = p.description;
        if (p.acceptance_criteria !== undefined) patch.acceptanceCriteria = p.acceptance_criteria;
        if (p.priority !== undefined) patch.priority = p.priority;
        const updated = await updateGoal(goalsDir, goal.id, patch, {
          timestamp: new Date().toISOString(),
          action: "updated",
          detail: p.note ?? "update",
          actor: "agent",
        });
        return { content: [{ type: "text", text: `Updated ${updated.label}` }], details: { goal: updated } };
      },
    },
    { name: "goal_update" },
  );

  api.registerTool(
    {
      name: "goal_complete",
      label: "Complete Goal",
      parameters: Type.Object({ goal_id: Type.String(), reason: Type.String() }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!gs.enabled) return notEnabled();
        const p = params as { goal_id: string; reason: string };
        const goal = await resolveGoalId(goalsDir, p.goal_id);
        if (!goal) return { content: [{ type: "text", text: "Goal not found." }], details: { error: "not_found" } };
        const completed = await terminateGoal(goalsDir, goal.id, "completed", p.reason, "agent", eventLog);
        if (cfg.activeTask.flushOnComplete !== false) {
          await flushGoalOutcomeToMemory(memoryDir, `Goal completed: ${completed.label}`, [`**Outcome:** ${p.reason}`]);
        }
        try {
          factsDb?.recordEpisode?.({
            event: `Goal completed: ${completed.label}`,
            outcome: "success",
            context: p.reason,
            importance: 0.7,
          });
        } catch {
          /* */
        }
        return { content: [{ type: "text", text: `Completed ${completed.label}` }], details: { goal: completed } };
      },
    },
    { name: "goal_complete" },
  );

  api.registerTool(
    {
      name: "goal_abandon",
      label: "Abandon Goal",
      parameters: Type.Object({ goal_id: Type.String(), reason: Type.String() }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!gs.enabled) return notEnabled();
        const p = params as { goal_id: string; reason: string };
        const goal = await resolveGoalId(goalsDir, p.goal_id);
        if (!goal) return { content: [{ type: "text", text: "Goal not found." }], details: { error: "not_found" } };
        const abandoned = await terminateGoal(goalsDir, goal.id, "abandoned", p.reason, "agent", eventLog);
        if (cfg.activeTask.flushOnComplete !== false) {
          await flushGoalOutcomeToMemory(memoryDir, `Goal abandoned: ${abandoned.label}`, [`**Reason:** ${p.reason}`]);
        }
        return { content: [{ type: "text", text: `Abandoned ${abandoned.label}` }], details: { goal: abandoned } };
      },
    },
    { name: "goal_abandon" },
  );
}
