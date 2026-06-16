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
    .requiredOption("--session-id <id>", "Session id (must match the runtime session key used during recall)")
    .action((topic: string, opts: { sessionId: string }) => {
      const state = setFocusTopic(opts.sessionId, topic);
      console.log(`Focus set: "${state.topic}" for session ${state.sessionId}`);
    });

  focus
    .command("clear")
    .description("Clear focus topic")
    .requiredOption("--session-id <id>", "Session id (must match the runtime session key used during recall)")
    .action((opts: { sessionId: string }) => {
      const cleared = clearFocusTopic(opts.sessionId);
      console.log(cleared ? "Focus cleared." : "No focus topic set.");
    });

  focus
    .command("show")
    .description("Show current focus topic")
    .requiredOption("--session-id <id>", "Session id (must match the runtime session key used during recall)")
    .action((opts: { sessionId: string }) => {
      const state = getFocusTopic(opts.sessionId);
      if (!state) {
        console.log("No focus topic.");
        return;
      }
      console.log(`Topic: ${state.topic} (set ${state.setAt})`);
    });
}
