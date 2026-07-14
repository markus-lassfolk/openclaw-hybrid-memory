/**
 * Curated `hybrid-mem help` guide (like `git help`).
 */

import type { Command } from "commander";
import type { Chainable } from "./shared.js";
import { withExit } from "./shared.js";

const WORKFLOW_GUIDE = `Hybrid Memory — quick start guide
=================================

First time?
  openclaw hybrid-mem setup
  openclaw hybrid-mem install
  openclaw hybrid-mem verify --fix

Daily maintenance:
  openclaw hybrid-mem maintenance nightly --verbose
  openclaw hybrid-mem maintenance cycle
  openclaw hybrid-mem maintenance steps

Something broken?
  openclaw hybrid-mem doctor
  openclaw hybrid-mem verify --fix
  openclaw hybrid-mem maintenance cron-health

Search & store:
  openclaw hybrid-mem search "your query"
  openclaw hybrid-mem store "fact text"

Grouped command namespaces (preferred):
  distill      Session distillation and extraction (run, window, extract-*)
  reflect      Reflection pipeline (patterns, rules, meta, identity, dream)
  storage      Vector and SQLite storage (stats, compact, optimize, reembed, …)
  quality      Data quality (duplicates, consolidate, contradictions, classify, …)
  learn        Self-correction and feedback learning
  maintenance  Orchestrator (cycle/nightly/full/steps), run-all, cron-health, …

Flat commands still work but print a deprecation warning — migrate to grouped names when convenient.

More examples:
  openclaw hybrid-mem examples maintenance
  openclaw hybrid-mem --help
`;

export function registerHelpCommand(mem: Chainable): void {
  const root = mem as Command;
  if (typeof root.helpCommand === "function") {
    root.helpCommand(false);
  }
  const helpCmd = mem.command("help").description("Curated guide to common hybrid-mem workflows");
  helpCmd.argument?.("[topic]", "Optional topic (currently shows the general guide)");
  helpCmd.action(
    withExit(async () => {
      console.log(WORKFLOW_GUIDE);
    }),
  );
}
