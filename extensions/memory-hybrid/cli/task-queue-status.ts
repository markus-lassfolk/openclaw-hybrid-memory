/**
 * CLI: print task queue state JSON for cron / strategic prompts (#983).
 * Reads ~/.openclaw/workspace/state/task-queue/current.json (after idle placeholder exists).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "../utils/fs.js";
import { ensureTaskQueueIdlePlaceholder, type TaskQueueItem } from "../services/task-queue-watchdog.js";
import type { Chainable } from "./shared.js";

export async function runTaskQueueStatusForCli(stateDir?: string): Promise<void> {
  const dir = stateDir ?? join(homedir(), ".openclaw", "workspace", "state", "task-queue");
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
  console.log(
    JSON.stringify(
      {
        ok: true,
        path: currentPath,
        available: true,
        current,
      },
      null,
      2,
    ),
  );
}

/** Register task-queue CLI helpers (status JSON + idle touch). */
export function registerTaskQueueStatusCommands(mem: Chainable): void {
  mem
    .command("task-queue-status")
    .description("Print task-queue current.json as JSON (for cron / scripts; #983)")
    .option("--state-dir <path>", "Override state directory (default: ~/.openclaw/workspace/state/task-queue)")
    .action(async (opts: { stateDir?: string }) => {
      await runTaskQueueStatusForCli(opts.stateDir);
    });

  mem
    .command("task-queue-touch")
    .description("Create task-queue state dir and idle current.json if missing (#983)")
    .option("--state-dir <path>", "Override state directory")
    .action(async (opts: { stateDir?: string }) => {
      const dir = opts.stateDir ?? join(homedir(), ".openclaw", "workspace", "state", "task-queue");
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
