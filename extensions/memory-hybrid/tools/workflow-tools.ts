/**
 * Workflow Tools — memory_workflows tool registration (Issue #209).
 *
 * Exposes workflow patterns (grouped by similar tool sequences) to the agent
 * so it can learn which tool sequences work best for given goals.
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { WorkflowStore } from "../backends/workflow-store.js";
import { extractGoalKeywords } from "../backends/workflow-store.js";
import { capturePluginError } from "../services/error-reporter.js";

interface WorkflowToolsContext {
	workflowStore: WorkflowStore;
}

export function registerWorkflowTools(
	ctx: WorkflowToolsContext,
	api: ClawdbotPluginApi,
): void {
	const { workflowStore } = ctx;

	// -------------------------------------------------------------------------
	// memory_workflows — query recorded workflow patterns
	// -------------------------------------------------------------------------
	api.registerTool({
		name: "memory_workflows",
		label: "Query Workflow Patterns",
		description:
			"Search recorded tool-sequence patterns to find which workflows succeed for a given goal. Returns patterns grouped by similar tool sequences with success rates and usage counts.",
		parameters: Type.Object({
			goal: Type.Optional(
				Type.String({
					description:
						"Optional natural-language goal to filter patterns by (keyword-matched). Omit to return all patterns.",
				}),
			),
			minSuccessRate: Type.Optional(
				Type.Number({
					minimum: 0,
					maximum: 1,
					description:
						"Minimum success rate (0–1) to include a pattern. Default: 0 (all patterns).",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 100,
					description: "Maximum number of patterns to return. Default: 20.",
				}),
			),
		}),
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			const { goal, minSuccessRate, limit } = params as {
				goal?: string;
				minSuccessRate?: number;
				limit?: number;
			};

			try {
				const hasGoalFilter = goal && goal.trim().length > 0;
				const patterns = workflowStore.getPatterns({
					minSuccessRate: minSuccessRate ?? 0,
					limit: hasGoalFilter ? undefined : (limit ?? 20),
				});

				// If goal supplied, further filter by keyword overlap
				let filtered = patterns;
				if (hasGoalFilter) {
					const keywords = new Set(extractGoalKeywords(goal));
					filtered = patterns.filter((p) =>
						p.exampleGoals.some((g) =>
							extractGoalKeywords(g).some((k) => keywords.has(k)),
						),
					);
					// Apply limit after goal filtering
					filtered = filtered.slice(0, limit ?? 20);
				}

				if (filtered.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: goal
									? `No workflow patterns found matching goal: "${goal}"`
									: "No workflow patterns recorded yet.",
							},
						],
						details: [],
					};
				}

				const lines = filtered.map((p, i) => {
					const rate = `${Math.round(p.successRate * 100)}%`;
					const seq = p.toolSequence.join(" → ");
					const goals = p.exampleGoals.map((g) => `"${g}"`).join(", ");
					return (
						`${i + 1}. [${rate} success, ${p.totalCount}× used, avg ${p.avgDurationMs}ms]\n` +
						`   Tools: ${seq || "(empty)"}\n` +
						`   Example goals: ${goals || "(none)"}`
					);
				});

				const summary = `Found ${filtered.length} workflow pattern(s)${goal ? ` matching "${goal}"` : ""}:\n\n${lines.join("\n\n")}`;

				return {
					content: [{ type: "text", text: summary }],
					details: filtered,
				};
			} catch (err) {
				const e = err instanceof Error ? err : new Error(String(err));
				capturePluginError(e, {
					subsystem: "workflows",
					operation: "memory-workflows",
					phase: "runtime",
				});
				const msg = e.message;
				if (
					/not open|connection is not open|The database connection is not open/i.test(
						msg,
					)
				) {
					return {
						content: [
							{
								type: "text",
								text: "Workflow patterns are temporarily unavailable (database not ready). Try again in a moment.",
							},
						],
						details: [],
					};
				}
				throw e;
			}
		},
	});
}
