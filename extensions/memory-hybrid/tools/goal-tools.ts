import { appendFile, mkdir } from "node:fs/promises";
import { GoalDispatchBroker } from "../services/goal-dispatch-broker.js";
import { join } from "node:path";
/**
 * Goal stewardship tools — see docs/GOAL-STEWARDSHIP-DESIGN.md
 */
import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { EventLog } from "../backends/event-log.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import {
  circuitBreakerShortBlocker,
  composeCircuitBreakerHumanSummary,
  computeCircuitBreakerStateAfterAssess,
  evaluateCircuitBreakerTrip,
} from "../services/goal-circuit-breaker.js";
import type { Goal, GoalHistoryEntry } from "../services/goal-stewardship-types.js";
import {
  evaluateGoalDispatch,
  isValidGoalDispatchPolicy,
  type GoalDispatchPolicy,
  type GoalDispatchRequest,
} from "../services/goal-dispatch-authorization.js";
import {
  type GoalUpdatePatch,
  type GoalVerification,
  createGoalWithCapCheck,
  goalStewardshipDefaultsFromConfig,
  isGlobalRateLimited,
  isTerminalStatus,
  listActiveGoals,
  recordGoalDispatch,
  resolveGoalId,
  resolveGoalIdResult,
  terminateGoal,
  updateGoal,
} from "../services/goal-stewardship.js";
import { listGoals, readGoal } from "../services/goal-registry.js";
import { verifyGoalMechanically } from "../services/goal-health.js";
import { runActiveTaskCheckpoint } from "../services/active-task-checkpoint.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { formatGoalClarityRejection, validateGoalRegisterClarity } from "../services/goal-register-validation.js";
import { validateMaxIterations } from "../services/goal-preflight.js";
import { guardAgainstWrapperArgsDropped } from "../services/tool-args-guard.js";
import { formatDateUtc, nowIso, nowSec } from "../utils/dates.js";
import { globalOnlyScopeFilter, scopeFieldsFromFilter } from "../utils/scope-filter.js";
import { stringEnum } from "../utils/typebox.js";
import type { BuildToolScopeFilterFn } from "../api/memory-plugin-api.js";

export interface GoalToolsContext {
  cfg: HybridMemoryConfig;
  goalsDir: string;
  workspaceRoot: string;
  /** Absolute path to ACTIVE-TASKS.md (for task hygiene tools). */
  resolvedActiveTaskPath: string;
  factsDb: FactsDB | null;
  vectorDb: VectorDB | null;
  embeddings: EmbeddingProvider | null;
  eventLog: EventLog | null;
  memoryDir: string;
  currentAgentIdRef: { value: string | null };
  buildToolScopeFilter: BuildToolScopeFilterFn;
}

const PRIORITIES = ["critical", "high", "normal", "low"] as const;

async function flushGoalOutcomeToMemory(memoryDir: string, title: string, lines: string[]): Promise<void> {
  const date = formatDateUtc(nowSec());
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
  const {
    cfg,
    goalsDir,
    factsDb,
    vectorDb,
    embeddings,
    eventLog,
    memoryDir,
    workspaceRoot,
    currentAgentIdRef,
    buildToolScopeFilter,
  } = ctx;
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

  const guardArgs = (toolName: string, params: Record<string, unknown>) =>
    guardAgainstWrapperArgsDropped(toolName, params, api.logger);

  api.registerTool(
    {
      name: "goal_dispatch",
      label: "Dispatch Goal Work",
      description:
        "Reserve and launch managed native goal work through the supported plugin runtime. Requires canonical goal_id; ACP returns a trusted-host launch request because the public plugin runtime exposes native subagent.run only.",
      parameters: Type.Object({
        goal_id: Type.String({ description: "Canonical goal UUID; labels are not accepted." }),
        agent_id: Type.String(),
        runtime: Type.Union([Type.Literal("subagent"), Type.Literal("acp")]),
        task: Type.String(),
        session_key: Type.String(),
        /** Explicit policy declaration. Omitting task_class only selects legacy `managed`; it never bypasses validation. */
        task_class: Type.Optional(Type.String()),
        read_only: Type.Optional(Type.Boolean()),
        repository: Type.Optional(Type.String({ description: "Canonical owner/repository for write dispatches." })),
        pr_number: Type.Optional(Type.Number()),
        branch: Type.Optional(Type.String()),
        live_remote_head: Type.Optional(Type.String()),
        write_scope: Type.Optional(Type.Array(Type.String())),
        creates_pr: Type.Optional(Type.Boolean()),
        creates_branch: Type.Optional(Type.Boolean()),
        budget: Type.Optional(
          Type.Object({
            max_dispatches: Type.Optional(Type.Number()),
            max_total_tokens: Type.Optional(Type.Number()),
            max_dispatch_tokens: Type.Optional(Type.Number()),
            max_wall_time_ms: Type.Optional(Type.Number()),
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!gs.enabled) return notEnabled();
        const p = params as any;
        const goalId = typeof p.goal_id === "string" ? p.goal_id.trim() : "";
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(goalId))
          return {
            content: [
              { type: "text" as const, text: "goal_id must be the canonical goal UUID; labels are not authority." },
            ],
            details: { error: "canonical_goal_id_required" },
          };
        const goal = await resolveGoalId(goalsDir, goalId);
        if (!goal || goal.id !== goalId)
          return {
            content: [{ type: "text" as const, text: "Active canonical goal not found." }],
            details: { error: "goal_not_found" },
          };
        // A completed/abandoned goal may still have an enabled cron job or a queued wake.
        // Make terminal state a hard dispatch boundary, not merely a controller convention.
        const terminalDispatchResult = (status: string) => ({
          content: [{ type: "text" as const, text: `Goal dispatch rejected: goal is terminal (${status}).` }],
          details: { error: "goal_terminal", goal_id: goalId, status },
        });
        if (isTerminalStatus(goal.status)) return terminalDispatchResult(goal.status);
        const isStillDispatchable = async () => {
          const fresh = await readGoal(goalsDir, goalId);
          return !!fresh && fresh.id === goalId && !isTerminalStatus(fresh.status);
        };
        const agent = typeof p.agent_id === "string" ? p.agent_id.trim() : "";
        const runtime = p.runtime;
        if (
          !agent ||
          (runtime !== "subagent" && runtime !== "acp") ||
          typeof p.task !== "string" ||
          typeof p.session_key !== "string"
        )
          return {
            content: [{ type: "text" as const, text: "agent_id, runtime, task, and session_key are required." }],
            details: { error: "invalid_dispatch_request" },
          };
        // `managed` remains the only compatibility default. Every dispatch, including
        // that legacy class, is evaluated against its full declared class policy.
        const taskClass = typeof p.task_class === "string" && p.task_class.trim() ? p.task_class.trim() : "managed";
        const request: GoalDispatchRequest = {
          taskClass,
          // The broker launches exactly `agent_id`; do not accept a second, caller-controlled identity.
          requestedAgent: agent,
          actualAgent: agent,
          readOnly: typeof p.read_only === "boolean" ? p.read_only : undefined,
          repository: typeof p.repository === "string" ? p.repository : undefined,
          prNumber: typeof p.pr_number === "number" ? p.pr_number : undefined,
          branch: typeof p.branch === "string" ? p.branch : undefined,
          liveRemoteHead: typeof p.live_remote_head === "string" ? p.live_remote_head : undefined,
          writeScope:
            Array.isArray(p.write_scope) && p.write_scope.every((value: unknown) => typeof value === "string")
              ? p.write_scope
              : undefined,
          createsPr: typeof p.creates_pr === "boolean" ? p.creates_pr : undefined,
          createsBranch: typeof p.creates_branch === "boolean" ? p.creates_branch : undefined,
        };
        if (goal.prereqStatus === "hitl" || goal.phase === "hitl")
          return {
            content: [
              {
                type: "text" as const,
                text: `Goal dispatch requires HITL: ${goal.prereqReasons.join("; ") || "prerequisites unresolved"}.`,
              },
            ],
            details: { error: "goal_prerequisites_unresolved" },
          };
        const preflight = evaluateGoalDispatch(goal.dispatchPolicy, request);
        if (!preflight.allowed)
          return {
            content: [{ type: "text" as const, text: `Dispatch denied by goal policy: ${preflight.reason}.` }],
            details: { error: "dispatch_policy_denied", policy_reason: preflight.reason, task_class: taskClass },
          };
        // Repeat the check after policy evaluation: goal termination can race a stale wake.
        const beforeReserve = await readGoal(goalsDir, goalId);
        if (!beforeReserve || beforeReserve.id !== goalId)
          return {
            content: [{ type: "text" as const, text: "Active canonical goal not found." }],
            details: { error: "goal_not_found" },
          };
        if (isTerminalStatus(beforeReserve.status)) return terminalDispatchResult(beforeReserve.status);
        // Atomically claim an iteration before reserving a launch. Duplicate pulses and restarts
        // therefore cannot consume the same iteration or silently run past the bound.
        let iterationRejected = false;
        let claimedIteration = 0;
        const iterated = await updateGoal(
          goalsDir,
          goalId,
          (fresh) => {
            if (fresh.iteration >= fresh.maxIterations) {
              iterationRejected = true;
              return {
                status: "blocked",
                phase: "hitl",
                escalationKind: "iteration_exhausted",
                humanEscalationSummary: `Iteration budget exhausted (${fresh.iteration}/${fresh.maxIterations}); human decision required.`,
                nextAction: "Human decides whether to extend scope/budget",
                lastOutcome: "iteration budget exhausted",
              };
            }
            claimedIteration = fresh.iteration + 1;
            return {
              iteration: claimedIteration,
              phase: fresh.phase === "discovery" ? "discovery" : "implementation",
              nextAction: `Dispatch iteration ${claimedIteration}`,
              blockerFingerprint: null,
            };
          },
          (_fresh, _patch) => ({
            timestamp: nowIso(),
            action: iterationRejected ? "iteration-exhausted" : "iteration-claimed",
            detail: iterationRejected ? "HITL escalation" : `iteration ${claimedIteration}`,
            actor: "steward",
          }),
        );
        if (iterationRejected)
          return {
            content: [
              {
                type: "text" as const,
                text: `Goal dispatch refused: iteration budget exhausted (${iterated.iteration}/${iterated.maxIterations}); HITL required.`,
              },
            ],
            details: { error: "iteration_exhausted", goal: iterated },
          };
        const budget = {
          maxDispatches: typeof p.budget?.max_dispatches === "number" ? p.budget.max_dispatches : undefined,
          maxTotalTokens: typeof p.budget?.max_total_tokens === "number" ? p.budget.max_total_tokens : undefined,
          maxDispatchTokens:
            typeof p.budget?.max_dispatch_tokens === "number" ? p.budget.max_dispatch_tokens : undefined,
          maxWallTimeMs: typeof p.budget?.max_wall_time_ms === "number" ? p.budget.max_wall_time_ms : undefined,
        };
        const broker = new GoalDispatchBroker(goalsDir);
        const canonical = goal.dispatchPolicy?.classes[taskClass]?.canonical;
        const record = await broker.reserve({
          goalId,
          targetAgent: agent,
          runtime,
          budget,
          ttlMs: 5 * 60_000,
          owner: agent,
          sessionId: p.session_key,
          isDispatchable: isStillDispatchable,
          target: canonical
            ? {
                repository: canonical.repository,
                prNumber: canonical.prNumber,
                branch: canonical.branch,
                remoteHead: canonical.remoteHead,
              }
            : undefined,
        });
        if (!record) {
          // The broker's lock-time predicate may have observed a terminal transition after
          // the pre-reservation read. Re-read so stale wakes report a terminal rejection,
          // rather than misleadingly blaming the dispatch budget.
          const afterReserve = await readGoal(goalsDir, goalId);
          if (afterReserve && afterReserve.id === goalId && isTerminalStatus(afterReserve.status))
            return terminalDispatchResult(afterReserve.status);
          return {
            content: [{ type: "text" as const, text: "Dispatch budget exhausted." }],
            details: { error: "budget_exhausted" },
          };
        }
        // The reservation may have been created just before a terminal transition. Do not
        // hand a stale ACP launcher grant to a cron wake, and do not launch a subagent.
        const beforeLaunch = await readGoal(goalsDir, goalId);
        if (!beforeLaunch || beforeLaunch.id !== goalId || isTerminalStatus(beforeLaunch.status)) {
          await broker.release(record.id, "goal_terminal_before_launch");
          return terminalDispatchResult(beforeLaunch?.status ?? "missing");
        }
        const grant = broker.token(record);
        if (runtime === "acp")
          return {
            content: [
              {
                type: "text" as const,
                text: "ACP dispatch reserved. A trusted host launcher must consume the dispatch request; this plugin cannot launch ACP through the public runtime.",
              },
            ],
            details: {
              ok: true,
              launched: false,
              dispatch_request: {
                dispatch_id: record.id,
                goal_id: goalId,
                target_agent: agent,
                runtime,
                session_key: p.session_key,
                task: p.task,
                task_class: taskClass,
                read_only: request.readOnly,
                pr_number: request.prNumber,
                branch: request.branch,
                live_remote_head: request.liveRemoteHead,
                write_scope: request.writeScope,
                creates_pr: request.createsPr,
                creates_branch: request.createsBranch,
                grant,
                expires_at: record.expiresAt,
                budget,
              },
            },
          };
        try {
          // Managed child launch is only supported while the host injects this request-scoped
          // runtime binding. Do not add a process-global fallback here: it would escape host
          // request authority and make an absent binding look like a completed E2E launch.
          const run = await api.runtime.subagent.run({
            sessionKey: p.session_key,
            message: p.task,
            idempotencyKey: record.id,
            deliver: false,
          });
          await broker.launch(record.id, run.runId);
          return {
            content: [{ type: "text" as const, text: `Managed goal dispatch launched (${run.runId}).` }],
            details: { ok: true, dispatch_id: record.id, run_id: run.runId, grant_expires_at: record.expiresAt },
          };
        } catch (err) {
          await broker.release(record.id, "launch_failed");
          const errorCode =
            err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : undefined;
          if (errorCode === "OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE")
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Managed dispatch requires the host-provided request-scoped subagent runtime; reservation released. E2E child completion is unverified until the host binding is available.",
                },
              ],
              details: { error: "subagent_runtime_request_scope_unavailable" },
            };
          return {
            content: [{ type: "text" as const, text: "Managed dispatch launch failed; reservation released." }],
            details: { error: "launch_failed" },
          };
        }
      },
    },
    { name: "goal_dispatch" },
  );

  api.registerTool(
    {
      name: "goal_list",
      label: "List Goals",
      description:
        "List registered stewardship goals (active by default). Use this instead of memory_recall to discover goal state.",
      parameters: Type.Object({
        include_terminal: Type.Optional(
          Type.Boolean({ description: "When true, include completed/abandoned goals (default: false)." }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!gs.enabled) return notEnabled();
        try {
          const includeTerminal = (params as { include_terminal?: boolean }).include_terminal === true;
          const goals = includeTerminal ? await listGoals(goalsDir) : await listActiveGoals(goalsDir);
          if (goals.length === 0) {
            return {
              content: [{ type: "text", text: "No goals found." }],
              details: { count: 0, goals: [] },
            };
          }
          const lines = goals.map(
            (g) =>
              `- [${g.priority}] ${g.label} (${g.status}, ${g.phase} ${g.iteration}/${g.maxIterations}, prereq: ${g.prereqStatus}, id: ${g.id}) — next: ${g.nextAction ?? "none"}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `${goals.length} goal(s):\n${lines.join("\n")}\n\nUse goal_get with id or label for full detail.`,
              },
            ],
            details: { count: goals.length, goals },
          };
        } catch (err) {
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "goal_list" },
  );

  api.registerTool(
    {
      name: "goal_get",
      label: "Get Goal",
      description: "Fetch one goal by id or label, including acceptance criteria, blockers, and linked tasks.",
      parameters: Type.Object({
        goal_id: Type.String({ description: "Goal UUID or label." }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!gs.enabled) return notEnabled();
        const dropped = guardArgs("goal_get", params);
        if (dropped) return dropped;
        const goalId = String((params as { goal_id?: string }).goal_id ?? "").trim();
        if (!goalId) {
          return {
            content: [{ type: "text", text: "Provide goal_id (UUID or label)." }],
            details: { error: "missing_goal_id" },
          };
        }
        const goal = await resolveGoalId(goalsDir, goalId);
        if (!goal) {
          return { content: [{ type: "text", text: "Goal not found." }], details: { error: "not_found" } };
        }
        const criteria = goal.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
        const blockers =
          goal.currentBlockers.length > 0 ? goal.currentBlockers.map((b) => `  - ${b}`).join("\n") : "  none";
        return {
          content: [
            {
              type: "text",
              text: [
                `Goal: ${goal.label} (${goal.id})`,
                `Status: ${goal.status} | Priority: ${goal.priority}`,
                `Description: ${goal.description}`,
                `Acceptance criteria:\n${criteria}`,
                `Blockers:\n${blockers}`,
                `Assessments: ${goal.assessmentCount}/${goal.maxAssessments} | Dispatches: ${goal.dispatchCount}/${goal.maxDispatches}`,
                goal.lastOutcome ? `Last outcome: ${goal.lastOutcome}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          details: { goal },
        };
      },
    },
    { name: "goal_get" },
  );

  api.registerTool(
    {
      name: "goal_register",
      label: "Register Goal",
      description:
        "Register a long-running goal with measurable acceptance criteria. If criteria are vague, the tool returns suggested criteria and follow-up questions — refine with the user, then retry with confirmed: true.",
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
        max_iterations: Type.Optional(Type.Number({ description: "Finite integer 1..100; defaults to 20." })),
        cooldown_minutes: Type.Optional(Type.Number()),
        confirmed: Type.Optional(
          Type.Boolean({
            description:
              "Set true after the user approves criteria (required for critical/high priority and after clarity refinement).",
          }),
        ),
        task_entity: Type.Optional(
          Type.String({
            description:
              "Optional active-task entity/label to link via related_goal + initial checkpoint (requires activeTask.enabled).",
          }),
        ),
        related_session: Type.Optional(Type.String({ description: "Session key for linked task checkpoint." })),
        initial_next: Type.Optional(Type.String({ description: "Initial next action for linked task row." })),
        dispatch_policy: Type.Optional(
          Type.Any({
            description:
              "Machine-readable generic dispatch policy. When authorization is enabled, goal-linked dispatches must select a policy class; write classes require canonical and scope constraints.",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!gs.enabled) return notEnabled();
        const dropped = guardArgs("goal_register", params);
        if (dropped) return dropped;
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
            max_iterations?: number;
            cooldown_minutes?: number;
            confirmed?: boolean;
            task_entity?: string;
            related_session?: string;
            initial_next?: string;
            dispatch_policy?: GoalDispatchPolicy;
          };
          const effectivePriority = p.priority ?? defaults.priority;
          if (validateMaxIterations(p.max_iterations) === undefined)
            return {
              content: [{ type: "text", text: "max_iterations must be a finite integer between 1 and 100." }],
              details: { error: "invalid_max_iterations" },
            };
          const clarity = validateGoalRegisterClarity({
            label: p.label,
            description: p.description,
            acceptance_criteria: p.acceptance_criteria,
            priority: effectivePriority,
          });
          if (!clarity.ok && p.confirmed !== true) {
            return {
              content: [{ type: "text", text: formatGoalClarityRejection(clarity) }],
              details: {
                error: "goal_criteria_unclear",
                ...clarity,
              },
            };
          }
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
          // Re-checked atomically under a global lock (see createGoalWithCapCheck) — the
          // earlier active.length check above is only a fast-path; two concurrent
          // registrations could otherwise both pass it before either one writes.
          const goal = await createGoalWithCapCheck(
            goalsDir,
            {
              label: p.label,
              description: p.description,
              acceptanceCriteria: p.acceptance_criteria,
              priority: p.priority,
              verification,
              maxDispatches: p.max_dispatches,
              maxAssessments: p.max_assessments,
              maxIterations: p.max_iterations,
              cooldownMinutes: p.cooldown_minutes,
              dispatchPolicy: p.dispatch_policy,
            },
            defaults,
            gs.globalLimits.maxActiveGoals,
            eventLog,
          );
          if (!goal) {
            return {
              content: [{ type: "text", text: `Max active goals (${gs.globalLimits.maxActiveGoals}) reached.` }],
              details: { error: "max_active_goals" },
            };
          }

          let taskLinkMessage = "";
          const taskEntity = p.task_entity?.trim();
          if (taskEntity && cfg.activeTask.enabled && factsDb && vectorDb && embeddings) {
            const cp = await runActiveTaskCheckpoint(
              {
                factsDb,
                vectorDb,
                embeddings,
                cfg,
                logger: api.logger,
                workspaceRoot,
                scopeFilter: buildToolScopeFilter({}, currentAgentIdRef.value, cfg),
              },
              {
                entity: taskEntity,
                status: "in_progress",
                title: goal.label,
                next: p.initial_next?.trim() || p.acceptance_criteria[0] || "Work toward goal acceptance criteria",
                relatedGoal: goal.id,
                relatedSession: p.related_session?.trim(),
              },
            );
            taskLinkMessage = cp.ok
              ? `\nLinked active task \`${taskEntity}\` (related_goal=${goal.id}).`
              : `\nWarning: goal registered but task link checkpoint failed: ${cp.message}`;
          }

          return {
            content: [{ type: "text", text: `Goal registered: ${goal.label} (${goal.id})${taskLinkMessage}` }],
            details: { goal, task_entity: taskEntity || undefined },
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
        const dropped = guardArgs("goal_assess", params);
        if (dropped) return dropped;
        try {
          const p = params as {
            goal_id?: string;
            assessment?: string;
            next_action?: string;
            blockers?: string[];
            dispatched?: boolean;
          };
          const goalId = typeof p.goal_id === "string" ? p.goal_id.trim() : "";
          const assessment = typeof p.assessment === "string" ? p.assessment.trim() : "";
          const nextAction = typeof p.next_action === "string" ? p.next_action.trim() : "";
          if (!goalId) {
            return {
              content: [{ type: "text", text: "goal_id is required." }],
              details: { error: "invalid_ref" },
            };
          }
          if (!assessment) {
            return {
              content: [{ type: "text", text: "assessment is required." }],
              details: { error: "invalid_ref" },
            };
          }
          if (!nextAction) {
            return {
              content: [{ type: "text", text: "next_action is required." }],
              details: { error: "invalid_ref" },
            };
          }
          const resolved = await resolveGoalIdResult(goalsDir, goalId);
          if (!resolved.ok) {
            return {
              content: [{ type: "text", text: resolved.message }],
              details: { error: resolved.code },
            };
          }
          const goal = resolved.goal;
          if (isTerminalStatus(goal.status)) {
            return { content: [{ type: "text", text: `Goal already ${goal.status}` }], details: { error: "terminal" } };
          }
          const ts = nowIso();
          // The assessmentCount/dispatchCount budget checks are intentionally NOT evaluated here
          // against this pre-lock `goal` snapshot. Two overlapping goal_assess calls could both
          // read the same one-below-cap count and both pass a pre-lock check; the authoritative
          // budget checks are re-evaluated against `fresh` inside computeAssessDecision below,
          // atomically with the increment (see the comment there), so a call can no longer push
          // assessmentCount/dispatchCount past their configured caps. Only isGlobalRateLimited is
          // still checked as a pre-lock fast path — it has its own independent file-based lock
          // and isn't derived from this goal's state, so it isn't subject to the same race.
          if (p.dispatched && isGlobalRateLimited(gs.globalLimits.maxDispatchesPerHour, goalsDir)) {
            return {
              content: [{ type: "text", text: "Global dispatch rate limit reached." }],
              details: { error: "rate_limited" },
            };
          }
          const blockersExplicitlyProvided = p.blockers !== undefined;
          const requestedBlockers = blockersExplicitlyProvided
            ? (p.blockers ?? [])
                .filter((b): b is string => typeof b === "string")
                .map((b) => b.trim())
                .filter(Boolean)
            : null;

          // Recompute everything derived from goal state (assessmentCount, blockers, circuit
          // breaker state, the trip decision, and the resulting patch) from `fresh` — the goal
          // as re-read *inside* updateGoal's lock — rather than from the pre-lock `goal` snapshot
          // above. A plain-object patch built from that snapshot would silently clobber a
          // concurrent writer's fresh state on commit: the lock only serializes *when* each
          // update lands, not what data drove its contents, so a concurrent goal_assess for the
          // same goal_id could otherwise let assessmentCount/dispatchCount undercount relative to
          // the number of assessments actually recorded to history, defeating the very budget
          // and circuit-breaker checks this mechanism exists to enforce.
          type AssessDecision = {
            patch: GoalUpdatePatch;
            historyEntries: GoalHistoryEntry[];
            outcome: "normal" | "circuit_breaker" | "assessment_budget" | "dispatch_budget" | "terminal";
            tripReason?: string;
          };
          const decisionRef: { current: AssessDecision | null } = { current: null };

          const computeAssessDecision = (fresh: Goal): AssessDecision => {
            // Re-check terminal status against `fresh` (read inside updateGoal's lock), not the
            // pre-lock `goal` snapshot above: a concurrent goal_complete/goal_fail/goal_abandon
            // call could have terminated this goal in the race window between that snapshot and
            // this lock being acquired. Without this, an assessment could still be recorded onto
            // an already-terminal goal — and worse, if the assessment/dispatch budget is
            // exhausted or the circuit breaker trips below, the patch would explicitly set
            // `status: "blocked"`, silently reopening a goal the system or user already closed.
            if (isTerminalStatus(fresh.status)) {
              return { patch: {}, historyEntries: [], outcome: "terminal" };
            }
            // Re-check both budgets against `fresh` (read inside updateGoal's lock), not the
            // pre-lock `goal` snapshot: this makes the budget check and the increment atomic
            // under a single lock acquisition, closing the race where two overlapping calls both
            // pass a stale pre-lock check and both proceed to increment past the cap.
            if (fresh.assessmentCount >= fresh.maxAssessments) {
              const budgetReason = "Assessment budget exhausted";
              return {
                patch: {
                  status: "blocked",
                  currentBlockers: fresh.currentBlockers.includes(budgetReason)
                    ? fresh.currentBlockers
                    : [...fresh.currentBlockers, budgetReason],
                },
                historyEntries: [{ timestamp: ts, action: "blocked", detail: "assessments", actor: "steward" }],
                outcome: "assessment_budget",
              };
            }
            if (p.dispatched && fresh.dispatchCount >= fresh.maxDispatches) {
              // No-op patch/history: matches the pre-fix behavior of rejecting the whole call
              // (including the assessment text) rather than partially recording it.
              return { patch: {}, historyEntries: [], outcome: "dispatch_budget" };
            }
            if (p.dispatched) recordGoalDispatch(goalsDir);
            const newBlockers = requestedBlockers ?? fresh.currentBlockers;
            const newAssessmentCount = fresh.assessmentCount + 1;
            const cbState = blockersExplicitlyProvided
              ? computeCircuitBreakerStateAfterAssess(fresh, newBlockers, newAssessmentCount)
              : {
                  lastBlockerFingerprint: fresh.lastBlockerFingerprint,
                  sameBlockerStreak: fresh.sameBlockerStreak,
                  circuitBreakerLastProgressAssessmentCount: fresh.circuitBreakerLastProgressAssessmentCount,
                };
            // Only evaluate a trip when this call actually provided fresh blocker evidence.
            // When blockers is omitted, cbState reuses the goal's frozen prior circuit-breaker
            // state while newAssessmentCount still advances — evaluating the trip here would let
            // the "assessments without progress" counter grow purely from call volume (an agent
            // simply not re-passing the optional blockers field) rather than genuine repeated-
            // blocker evidence, tripping the breaker "too early" relative to its documented intent
            // (stop retrying when blockers do not change).
            const tripEval = blockersExplicitlyProvided
              ? evaluateCircuitBreakerTrip(gs.circuitBreaker, cbState, newAssessmentCount)
              : ({ trip: false } as const);

            const basePatch = {
              assessmentCount: newAssessmentCount,
              lastAssessedAt: ts,
              dispatchCount: fresh.dispatchCount + (p.dispatched ? 1 : 0),
              lastDispatchedAt: p.dispatched ? ts : fresh.lastDispatchedAt,
              lastOutcome: `${assessment.slice(0, 400)} | next: ${nextAction.slice(0, 200)}`,
              currentBlockers: newBlockers,
              ...cbState,
            };

            const assessEntry: GoalHistoryEntry = {
              timestamp: ts,
              action: "assessed",
              detail: `${assessment.slice(0, 400)} | next: ${nextAction.slice(0, 100)}`,
              actor: "steward",
            };

            if (tripEval.trip) {
              const goalPreview = { ...fresh, ...basePatch, currentBlockers: newBlockers };
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
              return {
                patch: blockedPatch,
                historyEntries: [assessEntry, cbEntry],
                outcome: "circuit_breaker",
                tripReason: tripEval.reason,
              };
            }
            return { patch: basePatch, historyEntries: [assessEntry], outcome: "normal" };
          };

          const updated = await updateGoal(
            goalsDir,
            goal.id,
            (fresh) => {
              decisionRef.current = computeAssessDecision(fresh);
              return decisionRef.current.patch;
            },
            () => decisionRef.current?.historyEntries ?? [],
          );
          const decision = decisionRef.current;
          if (!decision) {
            throw new Error("memory-hybrid: goal_assess decision missing after updateGoal");
          }

          if (decision.outcome === "terminal") {
            return {
              content: [{ type: "text", text: `Goal ${updated.label} is already ${updated.status}.` }],
              details: { error: "terminal" },
            };
          }
          if (decision.outcome === "assessment_budget") {
            return { content: [{ type: "text", text: "Assessment budget exhausted." }], details: { error: "budget" } };
          }
          if (decision.outcome === "dispatch_budget") {
            return {
              content: [{ type: "text", text: "Dispatch budget exhausted." }],
              details: { error: "dispatch_budget" },
            };
          }

          if (decision.outcome === "circuit_breaker") {
            try {
              eventLog?.append({
                sessionId: "goal-stewardship",
                timestamp: ts,
                eventType: "action_taken",
                content: {
                  kind: "goal.circuit_breaker",
                  goalId: updated.id,
                  label: updated.label,
                  reason: decision.tripReason,
                },
              });
            } catch {
              /* */
            }
            if (gs.circuitBreaker.appendMemoryEscalation && updated.humanEscalationSummary) {
              await flushGoalOutcomeToMemory(memoryDir, `Circuit breaker: ${updated.label}`, [
                "**Summary:**",
                "",
                ...updated.humanEscalationSummary.split("\n"),
              ]);
            }
            return {
              content: [
                {
                  type: "text",
                  text: `Circuit breaker: ${updated.label} is blocked — human escalation required. See goal JSON (humanEscalationSummary) or workspace memory/.`,
                },
              ],
              details: { goal: updated, circuitBreaker: decision.tripReason },
            };
          }

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
            content: [{ type: "text", text: `Assessed ${updated.label}. Next: ${nextAction}` }],
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
        dispatch_policy: Type.Optional(Type.Any({ description: "Replacement machine-readable dispatch policy." })),
        note: Type.Optional(Type.String()),
        confirmed: Type.Optional(
          Type.Boolean({ description: "Required when updating acceptance_criteria after clarity refinement." }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!gs.enabled) return notEnabled();
        const dropped = guardArgs("goal_update", params);
        if (dropped) return dropped;
        try {
          const p = params as {
            goal_id: string;
            description?: string;
            acceptance_criteria?: string[];
            priority?: (typeof PRIORITIES)[number];
            dispatch_policy?: unknown;
            note?: string;
            confirmed?: boolean;
          };
          const goal = await resolveGoalId(goalsDir, p.goal_id);
          if (!goal) return { content: [{ type: "text", text: "Goal not found." }], details: { error: "not_found" } };
          if (isTerminalStatus(goal.status)) {
            return {
              content: [{ type: "text", text: `Goal ${goal.label} is already ${goal.status}.` }],
              details: { error: "terminal" },
            };
          }
          if (p.dispatch_policy !== undefined && !isValidGoalDispatchPolicy(p.dispatch_policy)) {
            return {
              content: [
                { type: "text", text: "dispatch_policy must be a version 1 policy with at least one valid class." },
              ],
              details: { error: "invalid_dispatch_policy" },
            };
          }
          if (p.acceptance_criteria !== undefined) {
            const clarity = validateGoalRegisterClarity({
              label: goal.label,
              description: p.description ?? goal.description,
              acceptance_criteria: p.acceptance_criteria,
              priority: p.priority ?? goal.priority,
            });
            if (!clarity.ok && p.confirmed !== true) {
              return {
                content: [{ type: "text", text: formatGoalClarityRejection(clarity) }],
                details: { error: "goal_criteria_unclear", ...clarity },
              };
            }
          }
          const staticPatch: Parameters<typeof updateGoal>[2] = {};
          if (p.description !== undefined) staticPatch.description = p.description;
          if (p.acceptance_criteria !== undefined) staticPatch.acceptanceCriteria = p.acceptance_criteria;
          if (p.priority !== undefined) staticPatch.priority = p.priority;
          if (p.dispatch_policy !== undefined) staticPatch.dispatchPolicy = p.dispatch_policy;
          const ts = nowIso();
          // Unlike goal_assess/goal_complete/goal_abandon, goal_update never re-checked terminal
          // status against the goal re-read inside updateGoal's lock — only against the pre-lock
          // snapshot above. A concurrent goal_complete/goal_fail/goal_abandon landing in that race
          // window would let this call silently rewrite description/acceptanceCriteria/priority
          // on an already-terminal goal, an audit-integrity gap (the goal's acceptance criteria
          // would no longer match what it was actually judged against when closed).
          let applied = true;
          const updated = await updateGoal(
            goalsDir,
            goal.id,
            (fresh) => {
              if (isTerminalStatus(fresh.status)) {
                applied = false;
                return {};
              }
              return staticPatch;
            },
            (fresh) =>
              isTerminalStatus(fresh.status)
                ? []
                : { timestamp: ts, action: "updated", detail: p.note ?? "update", actor: "agent" },
          );
          if (!applied) {
            return {
              content: [{ type: "text", text: `Goal ${updated.label} is already ${updated.status}; not updated.` }],
              details: { error: "terminal" },
            };
          }
          return { content: [{ type: "text", text: `Updated ${updated.label}` }], details: { goal: updated } };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "goal-tools",
            operation: "goal_update",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "goal_update" },
  );

  api.registerTool(
    {
      name: "goal_complete",
      label: "Complete Goal",
      description:
        "Mark a goal completed. When verification is configured, mechanical verification must pass unless confirmed:true with reason documents override.",
      parameters: Type.Object({
        goal_id: Type.String(),
        reason: Type.String(),
        confirmed: Type.Optional(
          Type.Boolean({
            description: "Set true to complete without passing mechanical verification (document why in reason).",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!gs.enabled) return notEnabled();
        const dropped = guardArgs("goal_complete", params);
        if (dropped) return dropped;
        try {
          const p = params as { goal_id: string; reason: string; confirmed?: boolean };
          const goal = await resolveGoalId(goalsDir, p.goal_id);
          if (!goal) return { content: [{ type: "text", text: "Goal not found." }], details: { error: "not_found" } };
          if (isTerminalStatus(goal.status)) {
            return {
              content: [{ type: "text", text: `Goal ${goal.label} is already ${goal.status}.` }],
              details: { error: "terminal" },
            };
          }
          if (goal.verification && goal.verification.type !== "manual" && p.confirmed !== true) {
            const mech = await verifyGoalMechanically(goal, workspaceRoot, gs);
            if (mech.detail !== "skip" && !mech.ok) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Cannot complete: mechanical verification failed (${mech.detail}). Fix criteria, run goal_assess, or retry with confirmed:true and a reason documenting manual acceptance.`,
                  },
                ],
                details: { error: "verification_failed", verification: mech },
              };
            }
          }
          if (goal.acceptanceCriteria.length > 0 && p.confirmed !== true && !goal.lastAssessedAt) {
            return {
              content: [
                {
                  type: "text",
                  text: "Goal has acceptance criteria but no assessment recorded. Call goal_assess first, or complete with confirmed:true after user accepts outcome.",
                },
              ],
              details: { error: "no_assessment" },
            };
          }
          const completed = await terminateGoal(goalsDir, goal.id, "completed", p.reason, "agent", eventLog);
          if (completed.status !== "completed") {
            // A concurrent goal_complete/goal_abandon call already terminated this goal in the
            // race window between the pre-lock check above and terminateGoal's own lock — it
            // no-op'd instead of double-terminating. Report the actual outcome, don't claim
            // success and fire completion side effects for a call that didn't apply.
            return {
              content: [{ type: "text", text: `Goal ${completed.label} is already ${completed.status}.` }],
              details: { error: "terminal" },
            };
          }
          if (cfg.activeTask.flushOnComplete !== false) {
            await flushGoalOutcomeToMemory(memoryDir, `Goal completed: ${completed.label}`, [
              `**Outcome:** ${p.reason}`,
            ]);
          }
          try {
            // SECURITY: unlike memory_record_episode, this has no caller-facing scope param —
            // always derive scope from the caller's own resolved identity, matching the sibling
            // tool's fallback-when-unspecified behavior, so this doesn't default to global scope.
            const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg) ?? globalOnlyScopeFilter();
            const { scope, scopeTarget } = scopeFieldsFromFilter(scopeFilter);
            factsDb?.recordEpisode?.({
              event: `Goal completed: ${completed.label}`,
              outcome: "success",
              context: p.reason,
              importance: 0.7,
              scope,
              scopeTarget,
              agentId: scopeFilter.agentId ?? undefined,
              userId: scopeFilter.userId ?? undefined,
              sessionId: scopeFilter.sessionId ?? undefined,
            });
          } catch {
            /* */
          }
          return { content: [{ type: "text", text: `Completed ${completed.label}` }], details: { goal: completed } };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "goal-tools",
            operation: "goal_complete",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
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
        const dropped = guardArgs("goal_abandon", params);
        if (dropped) return dropped;
        try {
          const p = params as { goal_id: string; reason: string };
          const goal = await resolveGoalId(goalsDir, p.goal_id);
          if (!goal) return { content: [{ type: "text", text: "Goal not found." }], details: { error: "not_found" } };
          if (isTerminalStatus(goal.status)) {
            return {
              content: [{ type: "text", text: `Goal ${goal.label} is already ${goal.status}.` }],
              details: { error: "terminal" },
            };
          }
          const abandoned = await terminateGoal(goalsDir, goal.id, "abandoned", p.reason, "agent", eventLog);
          if (abandoned.status !== "abandoned") {
            // Same race as goal_complete above: a concurrent terminate call already won.
            return {
              content: [{ type: "text", text: `Goal ${abandoned.label} is already ${abandoned.status}.` }],
              details: { error: "terminal" },
            };
          }
          if (cfg.activeTask.flushOnComplete !== false) {
            await flushGoalOutcomeToMemory(memoryDir, `Goal abandoned: ${abandoned.label}`, [
              `**Reason:** ${p.reason}`,
            ]);
          }
          try {
            const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg) ?? globalOnlyScopeFilter();
            const { scope, scopeTarget } = scopeFieldsFromFilter(scopeFilter);
            factsDb?.recordEpisode?.({
              event: `Goal abandoned: ${abandoned.label}`,
              outcome: "failure",
              context: p.reason,
              importance: 0.5,
              scope,
              scopeTarget,
              agentId: scopeFilter.agentId ?? undefined,
              userId: scopeFilter.userId ?? undefined,
              sessionId: scopeFilter.sessionId ?? undefined,
            });
          } catch {
            /* */
          }
          return { content: [{ type: "text", text: `Abandoned ${abandoned.label}` }], details: { goal: abandoned } };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "goal-tools",
            operation: "goal_abandon",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "goal_abandon" },
  );
}
