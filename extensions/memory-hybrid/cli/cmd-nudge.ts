/**
 * hybrid-mem nudge — suppress memory nudges for a session (Issue #1916).
 */

import { suppressNudgeForSession } from "../services/memory-nudge.js";
import type { Chainable } from "./shared.js";

export function registerNudgeCommands(program: Chainable): void {
  const nudge = program.command("nudge").description("Control memory nudge injection");

  nudge
    .command("suppress")
    .description("Suppress nudges for a session")
    .requiredOption("--session <id>", "Session id to suppress")
    .option("--hours <n>", "Suppress duration in hours", "24")
    .action((opts: { session?: string; hours?: string }) => {
      const sessionId = String(opts.session ?? "").trim();
      if (!sessionId) {
        console.error("--session is required.");
        process.exit(1);
      }
      const hours = Math.max(1, Number.parseInt(String(opts.hours ?? "24"), 10) || 24);
      suppressNudgeForSession(sessionId, hours);
      console.log(`Nudges suppressed for session ${sessionId} for ${hours}h.`);
    });
}
