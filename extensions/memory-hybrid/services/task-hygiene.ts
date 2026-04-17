/**
 * Task hygiene — stronger nudges for ACTIVE-TASKS.md rows (separate from Goals).
 * @see docs/TASK-HYGIENE.md
 */

import type { ActiveTaskEntry } from "./active-task.js";

export function buildHeartbeatTaskHygieneBlock(
	tasks: ActiveTaskEntry[],
	opts: {
		maxChars: number;
		suggestGoalAfterTaskAgeDays: number;
	},
): string {
	const stale = tasks.filter((t) => t.stale);
	const lines: string[] = [
		"<task-hygiene>",
		"**Heartbeat — active task review**",
		"Reconcile ACTIVE-TASKS.md: complete finished work, update **Next**, or verify subagents before replying HEARTBEAT_OK.",
	];

	if (stale.length > 0) {
		lines.push(
			`- **Stale tasks (${stale.length}):** ${stale.map((t) => `[${t.label}]`).join(", ")} — update or complete.`,
		);
	} else {
		lines.push("- No tasks flagged stale by the current threshold.");
	}

	if (opts.suggestGoalAfterTaskAgeDays > 0) {
		const cutoff = Date.now() - opts.suggestGoalAfterTaskAgeDays * 86_400_000;
		const longRunning = tasks.filter((t) => {
			const u = new Date(t.updated).getTime();
			return !Number.isNaN(u) && u < cutoff;
		});
		if (longRunning.length > 0) {
			lines.push(
				`- **Long-running (>${opts.suggestGoalAfterTaskAgeDays}d since last update):** ${longRunning.map((t) => `[${t.label}]`).join(", ")}`,
			);
			lines.push(
				"- If this work should survive many sessions, use **`active_task_propose_goal`** then **`goal_register`** (with acceptance criteria).",
			);
		}
	}

	lines.push("</task-hygiene>");
	let out = lines.join("\n");
	if (out.length > opts.maxChars) {
		out = `${out.slice(0, opts.maxChars - 20)}\n…(truncated)\n</task-hygiene>`;
	}
	return out;
}

/** Nudge on heartbeat when goals are blocked/stalled but ACTIVE-TASKS may look fine (issue #1096). */
export function buildGoalEscalationHeartbeatBlock(
	goals: Array<{ label: string; status: string }>,
	opts: { maxChars: number },
): string {
	const bad = goals.filter(
		(g) => g.status === "blocked" || g.status === "stalled",
	);
	if (bad.length === 0) return "";
	const lines: string[] = [
		"<goal-escalation>",
		"**Heartbeat — blocked or stalled goals**",
		"Do not reply HEARTBEAT_OK as if everything is fine until these are triaged or unblocked.",
		...bad.map((g) => `- **[${g.label}]** (${g.status})`),
		"</goal-escalation>",
	];
	const closingTag = "</goal-escalation>";
	const body = lines.join("\n");
	if (body.length <= opts.maxChars) {
		return body;
	}
	const openingTag = "<goal-escalation>";
	const truncatedSuffix = `\n…(truncated)\n${closingTag}`;
	const minChars = openingTag.length + truncatedSuffix.length;
	if (opts.maxChars < minChars) {
		return `${openingTag}${truncatedSuffix}`;
	}
	const availableBodyChars = opts.maxChars - truncatedSuffix.length;
	return `${body.slice(0, availableBodyChars)}${truncatedSuffix}`;
}

export function buildProposeGoalDraftFromTask(task: ActiveTaskEntry): {
	suggestedLabel: string;
	suggestedDescription: string;
	suggestedCriteria: string[];
	notes: string;
} {
	const criteria: string[] = [];
	if (task.next?.trim())
		criteria.push(`Complete next step: ${task.next.trim()}`);
	criteria.push(`Task was in status "${task.status}" (from ACTIVE-TASKS.md).`);
	criteria.push(
		"Verify outcome matches user expectations before calling goal_complete.",
	);
	return {
		suggestedLabel: task.label,
		suggestedDescription:
			task.description || `Follow through on active task [${task.label}]`,
		suggestedCriteria: criteria,
		notes:
			"This is a draft from the task row — refine acceptance_criteria with the user before goal_register when policy requires confirmation.",
	};
}
