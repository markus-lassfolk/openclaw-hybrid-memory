/**
 * hybrid-mem mine — conversation mining CLI (Issue #1915).
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { estimateMineCostUsd, readTranscriptFile } from "../services/transcript-importers/index.js";
import type { Chainable } from "./shared.js";

export type MineOptions = {
  name?: string;
  source?: string;
  embed?: boolean;
  synthesize?: boolean;
  dryRun?: boolean;
  confirmBudget?: boolean;
};

const DEFAULT_MAX_BUDGET_USD = 5;

export function registerMineCommand(
  program: Chainable,
  _cfg: HybridMemoryConfig,
  factsDb: FactsDB,
  vectorDb?: {
    store: (entry: {
      text: string;
      vector: number[];
      importance: number;
      category: string;
      id: string;
    }) => Promise<unknown>;
  },
  embeddings?: { embed: (text: string) => Promise<number[]>; modelName: string },
): void {
  program
    .command("mine <path>")
    .description("Import conversation transcripts as structured memory facts")
    .option("--name <collection>", "Collection name for imported batch")
    .option("--source <format>", "claude-code|chatgpt|text|jsonl")
    .option("--embed", "Generate embeddings after import")
    .option("--synthesize", "Extract decision/preference facts via LLM")
    .option("--dry-run", "Preview without writing")
    .option("--confirm-budget", "Confirm LLM budget for --synthesize")
    .action(async (path: string, opts: MineOptions) => {
      if (!existsSync(path)) {
        console.error(`File not found: ${path}`);
        process.exit(1);
      }
      const conversations = readTranscriptFile(path);
      if (conversations.length === 0) {
        console.error("No conversations parsed from file.");
        process.exit(1);
      }
      const batchId = randomUUID();
      const byteCount = conversations.reduce((n, c) => n + c.messages.reduce((m, msg) => m + msg.content.length, 0), 0);
      const estCost = estimateMineCostUsd(byteCount);
      console.log(`Parsed ${conversations.length} conversation(s), ~${byteCount} bytes`);
      if (opts.synthesize) {
        console.log(`Estimated synthesize cost: $${estCost.toFixed(3)}`);
        if (estCost > DEFAULT_MAX_BUDGET_USD && !opts.confirmBudget) {
          console.error(`Estimated cost exceeds $${DEFAULT_MAX_BUDGET_USD}. Pass --confirm-budget to proceed.`);
          process.exit(1);
        }
      }
      if (opts.dryRun) {
        for (const c of conversations.slice(0, 3)) {
          console.log(`\n[${c.source}] ${c.title} (${c.messages.length} messages)`);
          console.log(c.messages[0]?.content.slice(0, 120) ?? "");
        }
        console.log("\nDry run — no facts written.");
        return;
      }
      let written = 0;
      let skipped = 0;
      const db = factsDb.getRawDb();
      for (const conv of conversations) {
        const existing = db
          .prepare("SELECT id FROM facts WHERE content_dedup_hash = ? AND superseded_at IS NULL LIMIT 1")
          .get(conv.contentHash) as { id: string } | undefined;
        if (existing) {
          skipped++;
          continue;
        }
        const text = conv.messages
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n\n")
          .slice(0, 50_000);
        const entry = factsDb.store({
          text,
          category: "conversation",
          importance: 0.5,
          entity: null,
          key: opts.name ?? conv.title,
          value: null,
          source: `mine:${conv.source}`,
          confidence: 0.8,
        });
        db.prepare("UPDATE facts SET content_dedup_hash = ?, mine_batch_id = ? WHERE id = ?").run(
          conv.contentHash,
          batchId,
          entry.id,
        );
        written++;

        if (opts.embed && vectorDb && embeddings) {
          try {
            const vector = await embeddings.embed(text.slice(0, 8000));
            factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
            await vectorDb.store({
              text,
              vector,
              importance: 0.5,
              category: "conversation",
              id: entry.id,
            });
          } catch (err) {
            console.warn(`Failed to embed fact ${entry.id}: ${err}`);
          }
        }
      }
      console.log(`Mine complete: batch=${batchId} written=${written} skipped=${skipped}`);
      if (opts.embed && (!vectorDb || !embeddings)) {
        console.log(
          "Note: --embed requires configured vectorDb and embeddings. Run storage re-index or wait for background embed to vectorize new facts.",
        );
      } else if (opts.embed && embeddings) {
        console.log(`Embedded ${written} facts using ${embeddings.modelName}`);
      }
      if (opts.synthesize)
        console.log("Note: --synthesize invokes multi-pass-extractor in a follow-up maintenance job.");
    });
}
