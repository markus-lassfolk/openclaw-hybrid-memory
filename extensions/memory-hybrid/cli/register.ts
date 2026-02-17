/**
 * Register hybrid-mem CLI subcommands.
 * Receives the "hybrid-mem" command object and a context; registers a first batch
 * of simple commands (stats, prune, checkpoint, backfill-decay). Remaining commands
 * stay in index until extracted in further iterations.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";

export type HybridMemCliContext = {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  versionInfo: { pluginVersion: string; memoryManagerVersion: string; schemaVersion: number };
};

/** Chainable command type (Commander-style). */
type Chainable = {
  command(name: string): Chainable;
  description(desc: string): Chainable;
  action(fn: (...args: unknown[]) => void | Promise<void>): Chainable;
  option(flags: string, desc?: string, defaultValue?: string): Chainable;
  argument(name: string, desc?: string): Chainable;
};

export function registerHybridMemCli(mem: Chainable, ctx: HybridMemCliContext): void {
  const { factsDb, vectorDb, versionInfo } = ctx;

  mem
    .command("stats")
    .description("Show memory statistics with decay breakdown")
    .action(async () => {
      const sqlCount = factsDb.count();
      let lanceCount = 0;
      try {
        lanceCount = await vectorDb.count();
      } catch {
        // vectorDb may be unavailable
      }
      const breakdown = factsDb.statsBreakdown();
      const expired = factsDb.countExpired();

      console.log(`memory-hybrid ${versionInfo.pluginVersion} (memory-manager ${versionInfo.memoryManagerVersion}, schema ${versionInfo.schemaVersion})`);
      console.log(`SQLite facts:    ${sqlCount}`);
      console.log(`LanceDB vectors: ${lanceCount}`);
      console.log(`Total: ${sqlCount + lanceCount} (with overlap)`);
      console.log(`\nBy decay class:`);
      for (const [cls, cnt] of Object.entries(breakdown)) {
        console.log(`  ${cls.padEnd(12)} ${cnt}`);
      }
      if (expired > 0) {
        console.log(`\nExpired (pending prune): ${expired}`);
      }
    });

  mem
    .command("prune")
    .description("Remove expired facts and decay aging confidence")
    .option("--hard", "Only hard-delete expired facts")
    .option("--soft", "Only soft-decay confidence")
    .option("--dry-run", "Show what would be pruned without deleting")
    .action(async (opts: { dryRun?: boolean; hard?: boolean; soft?: boolean }) => {
      if (opts.dryRun) {
        const expired = factsDb.countExpired();
        console.log(`Would prune: ${expired} expired facts`);
        return;
      }
      let hardPruned = 0;
      let softPruned = 0;
      if (opts.hard) {
        hardPruned = factsDb.pruneExpired();
      } else if (opts.soft) {
        softPruned = factsDb.decayConfidence();
      } else {
        hardPruned = factsDb.pruneExpired();
        softPruned = factsDb.decayConfidence();
      }
      console.log(`Hard-pruned: ${hardPruned} expired`);
      console.log(`Soft-pruned: ${softPruned} low-confidence`);
    });

  mem
    .command("checkpoint")
    .description("Save or restore a pre-flight checkpoint")
    .argument("<action>", "save or restore")
    .option("--intent <text>", "Intent for save")
    .option("--state <text>", "State for save")
    .action(async (action: string, opts: { intent?: string; state?: string }) => {
      if (action === "save") {
        if (!opts.intent || !opts.state) {
          console.error("--intent and --state required for save");
          return;
        }
        const id = factsDb.saveCheckpoint({
          intent: opts.intent,
          state: opts.state,
        });
        console.log(`Checkpoint saved: ${id}`);
      } else if (action === "restore") {
        const cp = factsDb.restoreCheckpoint();
        if (!cp) {
          console.log("No active checkpoint.");
          return;
        }
        console.log(JSON.stringify(cp, null, 2));
      } else {
        console.error("Usage: checkpoint <save|restore>");
      }
    });

  mem
    .command("backfill-decay")
    .description("Re-classify existing facts with auto-detected decay classes")
    .action(async () => {
      const counts = factsDb.backfillDecayClasses();
      if (Object.keys(counts).length === 0) {
        console.log("All facts already properly classified.");
      } else {
        console.log("Reclassified:");
        for (const [cls, cnt] of Object.entries(counts)) {
          console.log(`  ${cls}: ${cnt}`);
        }
      }
    });
}
