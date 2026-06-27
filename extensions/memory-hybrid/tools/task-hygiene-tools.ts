/**
 * Task hygiene tools — draft goal_register payloads from active tasks; list/get tasks.
 * @see docs/TASK-HYGIENE.md
 */
import { isAbsolute, join as pathJoin } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import type { ActiveTaskEntry } from "../services/active-task.js";
import { findActiveTaskByLabel, loadActiveTasksForTools } from "../services/active-task-tools-loader.js";
import { capturePluginError } from "../services/error-reporter.js";
import { guardAgainstWrapperArgsDropped } from "../services/tool-args-guard.js";
import { buildProposeGoalDraftFromTask } from "../services/task-hygiene.js";
import { stableStringify } from "../utils/stable-stringify.js";

export interface TaskHygieneToolsContext {
  cfg: HybridMemoryConfig;
  /** Absolute path to ACTIVE-TASKS.md */
  resolvedActiveTaskPath: string;
  workspaceRoot: string;
  factsDb: FactsDB | null;
}

export function resolveActiveTaskPathForTools(cfg: HybridMemoryConfig, workspaceRoot: string): string {
  return isAbsolute(cfg.activeTask.filePath)
    ? cfg.activeTask.filePath
    : pathJoin(workspaceRoot, cfg.activeTask.filePath);
}

function formatTaskSummary(task: ActiveTaskEntry): string {
  const lines = [
    `**Label:** ${task.label}`,
    `**Status:** ${task.status}`,
    `**Description:** ${task.description}`,
    `**Updated:** ${task.updated}`,
  ];
  if (task.next) lines.push(`**Next:** ${task.next}`);
  if (task.subagent) lines.push(`**Subagent:** ${task.subagent}`);
  if (task.relatedGoal) lines.push(`**Related goal:** ${task.relatedGoal}`);
  if (task.stale) lines.push(`**Stale:** yes (needs active_task_checkpoint)`);
  return lines.join("\n");
}

export function registerTaskHygieneTools(ctx: TaskHygieneToolsContext, api: ClawdbotPluginApi): void {
  const path = ctx.resolvedActiveTaskPath;
  const { cfg, factsDb } = ctx;

  const disabled = () => ({
    content: [
      {
        type: "text" as const,
        text: "Active tasks are disabled. Set activeTask.enabled: true and ensure ACTIVE-TASKS.md exists.",
      },
    ],
    details: { error: "active_task_disabled" },
  });

  const guardArgs = (toolName: string, params: Record<string, unknown>) =>
    guardAgainstWrapperArgsDropped(toolName, params, api.logger);

  api.registerTool(
    {
      name: "active_task_list",
      label: "List active tasks",
      description:
        "List active tasks from the configured ledger (facts or ACTIVE-TASKS.md). Use instead of memory_recall for tactical task state.",
      parameters: Type.Object({
        include_stale: Type.Optional(
          Type.Boolean({ description: "When true, include stale tasks (default: true)." }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!cfg.activeTask.enabled) return disabled();
        const dropped = guardArgs("active_task_list", params);
        if (dropped) return dropped;
        try {
          const loaded = await loadActiveTasksForTools(cfg, path, factsDb);
          if (!loaded) {
            return {
              content: [{ type: "text", text: "Active task ledger unavailable (facts DB required when ledger=facts)." }],
              details: { error: "ledger_unavailable" },
            };
          }
          const includeStale = (params as { include_stale?: boolean }).include_stale !== false;
          const activeStatuses = new Set(["In progress", "Waiting", "Stalled", "Failed"]);
          let tasks = loaded.tasks.filter((t) => activeStatuses.has(t.status));
          if (!includeStale) tasks = tasks.filter((t) => !t.stale);
          if (tasks.length === 0) {
            return {
              content: [{ type: "text", text: "No active tasks in ledger." }],
              details: { tasks: [], source: loaded.source, path: loaded.path },
            };
          }
          const text = tasks
            .map(
              (t) =>
                `- **${t.label}** (${t.status}${t.stale ? ", stale" : ""}) — ${t.description.slice(0, 120)}${t.next ? ` | next: ${t.next.slice(0, 80)}` : ""}${t.relatedGoal ? ` | goal: ${t.relatedGoal}` : ""}`,
            )
            .join("\n");
          return {
            content: [{ type: "text", text: `Active tasks (${tasks.length}, source=${loaded.source}):\n\n${text}` }],
            details: { tasks, source: loaded.source, path: loaded.path },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "task-hygiene-tools",
            operation: "active_task_list",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "active_task_list" },
  );

  api.registerTool(
    {
      name: "active_task_get",
      label: "Get active task",
      description: "Fetch one active task row by label from the configured ledger.",
      parameters: Type.Object({
        task_label: Type.String({ minLength: 1 }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!cfg.activeTask.enabled) return disabled();
        const dropped = guardArgs("active_task_get", params);
        if (dropped) return dropped;
        try {
          const loaded = await loadActiveTasksForTools(cfg, path, factsDb);
          if (!loaded) {
            return {
              content: [{ type: "text", text: "Active task ledger unavailable." }],
              details: { error: "ledger_unavailable" },
            };
          }
          const want = String((params as { task_label: string }).task_label).trim();
          const task = findActiveTaskByLabel(loaded.tasks, want);
          if (!task) {
            return {
              content: [
                {
                  type: "text",
                  text: `No task with label "${want}". Labels: ${loaded.tasks.map((t) => t.label).join(", ") || "(none)"}`,
                },
              ],
              details: { error: "task_not_found", path: loaded.path, source: loaded.source },
            };
          }
          return {
            content: [{ type: "text", text: formatTaskSummary(task) }],
            details: { task, path: loaded.path, source: loaded.source },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "task-hygiene-tools",
            operation: "active_task_get",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "active_task_get" },
  );

  api.registerTool(
    {
      name: "active_task_propose_goal",
      label: "Propose goal from active task",
      description:
        "Return a draft goal_register payload for a task label (reads facts ledger when activeTask.ledger=facts).",
      parameters: Type.Object({
        task_label: Type.String({ minLength: 1 }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!cfg.activeTask.enabled) return disabled();
        const dropped = guardArgs("active_task_propose_goal", params);
        if (dropped) return dropped;
        try {
          const loaded = await loadActiveTasksForTools(cfg, path, factsDb);
          if (!loaded) {
            return {
              content: [{ type: "text", text: "Active task ledger unavailable." }],
              details: { error: "ledger_unavailable" },
            };
          }
          const activeStatuses = new Set(["In progress", "Waiting", "Stalled"]);
          const active = loaded.tasks.filter((t) => activeStatuses.has(t.status));
          if (active.length === 0) {
            return {
              content: [{ type: "text", text: "No active tasks in ledger (or file missing)." }],
              details: { error: "no_active_tasks", path: loaded.path, source: loaded.source },
            };
          }
          const want = String((params as { task_label: string }).task_label).trim();
          const task = findActiveTaskByLabel(active, want);
          if (!task) {
            return {
              content: [
                {
                  type: "text",
                  text: `No active task with label matching "${want}". Labels: ${active.map((t) => t.label).join(", ")}`,
                },
              ],
              details: { error: "task_not_found", path: loaded.path, source: loaded.source },
            };
          }
          const draft = buildProposeGoalDraftFromTask(task);
          const goalRegisterExample = {
            label: draft.suggestedLabel,
            description: draft.suggestedDescription,
            acceptance_criteria: draft.suggestedCriteria,
            task_entity: task.label,
          };
          const text = [
            "**Draft for `goal_register` (refine with the user before calling when policy requires confirmation):**",
            "",
            "```json",
            stableStringify(goalRegisterExample),
            "```",
            "",
            `**Notes:** ${draft.notes}`,
            loaded.source === "facts" ? `(Loaded from facts ledger; projection file: ${loaded.path})` : "",
          ]
            .filter(Boolean)
            .join("\n");
          return {
            content: [{ type: "text", text }],
            details: {
              draft,
              goal_register_suggestion: goalRegisterExample,
              activeTaskPath: loaded.path,
              source: loaded.source,
            },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "task-hygiene-tools",
            operation: "active_task_propose_goal",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "active_task_propose_goal" },
  );
}
