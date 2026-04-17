/**
 * CLI: print task queue state JSON for cron / strategic prompts (#983).
 * Reads ~/.openclaw/workspace/state/task-queue/current.json (after idle placeholder exists).
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readActiveTaskFileWithResolvedPath } from "../services/active-task.js";
import {
	type TaskQueueItem,
	ensureTaskQueueIdlePlaceholder,
	taskQueueItemHasRecognizedSemantics,
	writeCanonicalIdleTaskQueueFile,
} from "../services/task-queue-watchdog.js";
import { getEnv } from "../utils/env-manager.js";
import { readJsonFile } from "../utils/fs.js";
import type { Chainable } from "./shared.js";

export type TaskQueueStatusCliOptions = {
	stateDir?: string;
	/** Include ACTIVE-TASKS.md summary when the file exists (default path: workspace/ACTIVE-TASKS.md). */
	withActiveTasks?: boolean;
	/** Default ACTIVE-TASKS.md path relative to workspace when not absolute. */
	activeTaskRelativePath?: string;
};

export async function runTaskQueueStatusForCli(
	opts: TaskQueueStatusCliOptions = {},
): Promise<void> {
	const dir =
		opts.stateDir ??
		join(homedir(), ".openclaw", "workspace", "state", "task-queue");
	const currentPath = join(dir, "current.json");
	if (!existsSync(currentPath)) {
		console.log(
			JSON.stringify(
				{
					ok: true,
					path: currentPath,
					available: false,
					reason: "missing",
					hint: "Run the gateway with hybrid-memory (task-queue watchdog creates an idle placeholder) or `openclaw hybrid-mem task-queue-touch`.",
				},
				null,
				2,
			),
		);
		return;
	}
	const current = await readJsonFile<TaskQueueItem>(currentPath);
	if (current == null) {
		console.log(
			JSON.stringify(
				{
					ok: true,
					path: currentPath,
					available: false,
					reason: "malformed",
					hint: "current.json exists but is not valid JSON or is empty — repair or replace the file.",
				},
				null,
				2,
			),
		);
		return;
	}
	const recognized = taskQueueItemHasRecognizedSemantics(current);
	const out: Record<string, unknown> = {
		ok: true,
		path: currentPath,
		available: true,
		recognized,
		current,
	};
	if (!recognized) {
		out.hint =
			"current.json is not a recognized task-queue payload (metadata-only shells are repaired by the watchdog or `task-queue-touch --repair`). See issue #1037.";
	}

	if (opts.withActiveTasks) {
		const workspaceRoot =
			getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
		const rel = opts.activeTaskRelativePath ?? "ACTIVE-TASKS.md";
		const activePath = isAbsolute(rel) ? rel : join(workspaceRoot, rel);
		try {
			const file = await readActiveTaskFileWithResolvedPath(
				activePath,
				7 * 24 * 60,
			);
			if (!file) {
				out.activeTasks = { filePath: activePath, available: false };
			} else {
				const { readFrom, ...rest } = file;
				out.activeTasks = {
					filePath: activePath,
					...(readFrom !== activePath ? { readFrom } : {}),
					active: rest.active.map((t) => ({
						label: t.label,
						description: t.description,
						status: t.status,
						branch: t.branch,
						subagent: t.subagent,
						next: t.next,
						updated: t.updated,
					})),
					completedCount: rest.completed.length,
				};
			}
		} catch {
			out.activeTasks = { filePath: activePath, error: "could_not_read" };
		}
	}

	console.log(JSON.stringify(out, null, 2));
}

/** Register task-queue CLI helpers (status JSON + idle touch). */
export function registerTaskQueueStatusCommands(mem: Chainable): void {
	mem
		.command("task-queue-status")
		.description(
			"Print task-queue current.json as JSON (for cron / scripts; #983)",
		)
		.option(
			"--state-dir <path>",
			"Override state directory (default: ~/.openclaw/workspace/state/task-queue)",
		)
		.option(
			"--with-active-tasks",
			"Include ACTIVE-TASKS.md summary (workspace/ACTIVE-TASKS.md by default)",
		)
		.option(
			"--active-task-file <path>",
			"ACTIVE-TASKS.md path (absolute or relative to OPENCLAW_WORKSPACE / ~/.openclaw/workspace)",
		)
		.action(
			async (opts: {
				stateDir?: string;
				withActiveTasks?: boolean;
				activeTaskFile?: string;
			}) => {
				await runTaskQueueStatusForCli({
					stateDir: opts.stateDir,
					withActiveTasks: !!opts.withActiveTasks,
					activeTaskRelativePath: opts.activeTaskFile,
				});
			},
		);

	mem
		.command("task-queue-touch")
		.description(
			"Create task-queue state dir and idle current.json if missing (#983); use --repair to fix bad snapshots",
		)
		.option("--state-dir <path>", "Override state directory")
		.option(
			"--repair",
			"If current.json exists but is not a recognized queue payload, archive it to history/ and write canonical idle (#1037)",
		)
		.action(async (opts: { stateDir?: string; repair?: boolean }) => {
			const dir =
				opts.stateDir ??
				join(homedir(), ".openclaw", "workspace", "state", "task-queue");
			if (opts.repair && existsSync(join(dir, "current.json"))) {
				const currentPath = join(dir, "current.json");
				const raw = await readJsonFile<TaskQueueItem>(currentPath);
				if (raw === null) {
					console.error(
						`✗ current.json is malformed (not valid JSON) — delete manually or check task-queue-status for details`,
					);
					return;
				}
				if (!taskQueueItemHasRecognizedSemantics(raw)) {
					const { mkdir, writeFile } = await import("node:fs/promises");
					const histDir = join(dir, "history");
					await mkdir(histDir, { recursive: true });
					const archived = {
						...raw,
						repairedBy: "task-queue-touch",
						repairedAt: new Date().toISOString(),
					};
					const body = JSON.stringify(archived, null, 2);
					let dest = "";
					for (let attempt = 0; attempt < 16; attempt++) {
						const ts = new Date().toISOString().replace(/[:.]/g, "-");
						dest = join(histDir, `${ts}-${randomUUID()}-degenerate-cli.json`);
						try {
							await writeFile(dest, body, { encoding: "utf-8", flag: "wx" });
							break;
						} catch (e) {
							if (
								(e as NodeJS.ErrnoException).code !== "EEXIST" ||
								attempt === 15
							)
								throw e;
						}
					}
					await writeCanonicalIdleTaskQueueFile(dir, {
						info: (m) => console.log(m),
					});
					console.log(
						`✓ Repaired degenerate current.json — archived to ${dest} and wrote idle placeholder`,
					);
					return;
				}
			}
			const wrote = await ensureTaskQueueIdlePlaceholder(dir, {
				info: (m) => console.log(m),
			});
			if (wrote) {
				console.log(`✓ Idle placeholder written under ${dir}`);
			} else {
				console.log(`current.json already exists — left unchanged (${dir})`);
			}
		});
}
