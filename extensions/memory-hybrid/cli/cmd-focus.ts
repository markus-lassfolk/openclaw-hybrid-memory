/**
 * hybrid-mem focus topic CLI (Issue #1917).
 */

import type { Chainable } from "./shared.js";
import { clearFocusTopic, getFocusTopic, setFocusTopic } from "../services/focus-topic.js";

export function registerFocusCommands(program: Chainable): void {
  const focus = program.command("focus").description("Session focus topic (ephemeral, not in SQLite)");

  focus
    .command("set <topic>")
    .description("Set focus topic for a session")
    .option("--session-id <id>", "Session id", "default")
    .action((topic: string, opts: { sessionId?: string }) => {
      const state = setFocusTopic(opts.sessionId ?? "default", topic);
      console.log(`Focus set: "${state.topic}" for session ${state.sessionId}`);
    });

  focus
    .command("clear")
    .description("Clear focus topic")
    .option("--session-id <id>", "Session id", "default")
    .action((opts: { sessionId?: string }) => {
      const cleared = clearFocusTopic(opts.sessionId ?? "default");
      console.log(cleared ? "Focus cleared." : "No focus topic set.");
    });

  focus
    .command("show")
    .description("Show current focus topic")
    .option("--session-id <id>", "Session id", "default")
    .action((opts: { sessionId?: string }) => {
      const state = getFocusTopic(opts.sessionId ?? "default");
      if (!state) {
        console.log("No focus topic.");
        return;
      }
      console.log(`Topic: ${state.topic} (set ${state.setAt})`);
    });
}
