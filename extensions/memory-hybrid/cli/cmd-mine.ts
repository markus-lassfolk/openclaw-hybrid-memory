/**
 * hybrid-mem mine — conversation mining CLI (Issue #1915).
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import {
  estimateMineCostUsd,
  hashStoredTranscriptText,
  readTranscriptFile,
  redactSecretsInText,
} from "../services/transcript-importers/index.js";
import { cleanupEvictedVector } from "../services/vector-maintenance.js";
import { deleteVectorsForFactIds } from "../services/vector-maintenance.js";
import { createTransaction } from "../utils/sqlite-transaction.js";
import type { Chainable } from "./shared.js";

export type MineOptions = {
  name?: string;
  source?: string;
  embed?: boolean;
  synthesize?: boolean;
  dryRun?: boolean;
  confirmBudget?: boolean;
  scope?: "global" | "user" | "agent" | "session";
  scopeTarget?: string;
};

const DEFAULT_MAX_BUDGET_USD = 5;

export async function executeMineCommand(
  path: string,
  opts: MineOptions & { undo?: string },
  factsDb: FactsDB,
  vectorDb?: {
    store: (entry: {
      text: string;
      vector: number[];
      importance: number;
      category: string;
      id: string;
    }) => Promise<unknown>;
    delete: (factId: string) => Promise<boolean>;
  },
  embeddings?: { embed: (text: string) => Promise<number[]>; modelName: string },
): Promise<void> {
  if (opts.scope && !["global", "user", "agent", "session"].includes(opts.scope)) {
    console.error(`error: invalid --scope: ${opts.scope} (must be one of: global, user, agent, session)`);
    process.exit(1);
  }
  if (opts.undo) {
    const db = factsDb.getRawDb();
    const now = Math.floor(Date.now() / 1000);
    // Mirror the scope filter mining writes with (see mineScope/mineScopeTarget above) so
    // --undo can't supersede facts outside the caller's declared scope just because it
    // happens to know a batch id from a different tenant/scope (Issue: cross-tenant supersede).
    const undoScope = opts.scope ?? "global";
    const undoScopeTarget = undoScope === "global" ? null : (opts.scopeTarget?.trim() ?? null);
    const factIds = (
      db
        .prepare(
          `SELECT id FROM facts WHERE mine_batch_id = ? AND superseded_at IS NULL
         AND scope = ? AND (scope_target IS ? OR scope_target IS NULL)
         AND id NOT IN (SELECT fact_id FROM verified_facts)`,
        )
        .all(opts.undo, undoScope, undoScopeTarget) as Array<{ id: string }>
    ).map((r) => r.id);
    const result = db
      .prepare(
        `UPDATE facts SET superseded_at = ?, superseded_by = 'mine-undo'
         WHERE mine_batch_id = ? AND superseded_at IS NULL
         AND scope = ? AND (scope_target IS ? OR scope_target IS NULL)
         AND id NOT IN (SELECT fact_id FROM verified_facts)`,
      )
      .run(now, opts.undo, undoScope, undoScopeTarget);
    if (vectorDb && factIds.length > 0) {
      await deleteVectorsForFactIds(vectorDb, factIds, { operation: "mine-undo" });
    }
    console.log(
      `Undid mine batch ${opts.undo}: ${result.changes} fact(s) superseded, ${factIds.length} vector(s) deleted.`,
    );
    return;
  }
  if (!path) {
    console.error("Path is required unless using --undo.");
    process.exit(1);
  }
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }
  const conversations = readTranscriptFile(path, opts.source);
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
  let redactedTotal = 0;
  const redactionCategories: Record<string, number> = {};
  const db = factsDb.getRawDb();
  const sourceLabel = conversations[0]?.source ?? opts.source ?? "unknown";
  const mineScope = opts.scope ?? "global";
  const mineScopeTarget = mineScope === "global" ? null : (opts.scopeTarget?.trim() ?? null);
  for (const conv of conversations) {
    const rawText = conv.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")
      .slice(0, 50_000);
    const { text, redacted, categories } = redactSecretsInText(rawText);
    const storedContentHash = hashStoredTranscriptText(text);

    const importOne = createTransaction(db, () => {
      const existing = db
        .prepare(
          "SELECT id FROM facts WHERE content_dedup_hash = ? AND superseded_at IS NULL AND scope = ? AND (scope_target IS ? OR scope_target IS NULL) LIMIT 1",
        )
        .get(storedContentHash, mineScope, mineScopeTarget) as { id: string } | undefined;
      if (existing) return { skipped: true as const };

      const result = factsDb.storeWithResult({
        text,
        category: "conversation",
        importance: 0.5,
        entity: null,
        key: opts.name ?? conv.title,
        value: null,
        source: `mine:${conv.source}`,
        confidence: 0.8,
        scope: mineScope,
        scopeTarget: mineScopeTarget,
      });
      if (result.skipped || !result.newlyStored) return { skipped: true as const };
      db.prepare("UPDATE facts SET content_dedup_hash = ?, mine_batch_id = ? WHERE id = ?").run(
        storedContentHash,
        batchId,
        result.entry.id,
      );
      return { skipped: false as const, result, text };
    });

    redactedTotal += redacted;
    for (const [k, v] of Object.entries(categories)) {
      redactionCategories[k] = (redactionCategories[k] ?? 0) + v;
    }

    const txResult = importOne();
    if (txResult.skipped) {
      skipped++;
      continue;
    }

    const { result, text: storedText } = txResult;
    written++;

    if (result.evictedFactId && vectorDb) {
      await cleanupEvictedVector({
        vectorDb,
        evictedFactId: result.evictedFactId,
        context: "mine",
      });
    }

    if (opts.embed && vectorDb && embeddings) {
      try {
        const vector = await embeddings.embed(storedText.slice(0, 8000));
        // Store the vector FIRST, then mark the fact embedded — marking it first meant a
        // vectorDb.store() failure (disk full, IPC hiccup) after the mark left the fact with
        // embedding_model set but no actual Lance row, permanently invisible to the vectorless
        // audit/reembed-vectorless repair path (it only looks for facts with embedding_model
        // unset). See utils/fact-embeddings.ts's documented ordering contract.
        await vectorDb.store({
          text: storedText,
          vector,
          importance: 0.5,
          category: "conversation",
          id: result.entry.id,
        });
        factsDb.setEmbeddingModel(result.entry.id, embeddings.modelName);
      } catch (err) {
        console.warn(`Failed to embed fact ${result.entry.id}: ${err}`);
      }
    }
  }
  console.log(
    [
      `source: ${sourceLabel}`,
      `files: 1`,
      `conversations: ${conversations.length}`,
      `facts created: ${written} (conversation)`,
      `credentials redacted: ${redactedTotal}`,
      `mine_batch_id: ${batchId}`,
    ].join("\n"),
  );
  if (Object.keys(redactionCategories).length > 0) {
    console.log(`redaction categories: ${JSON.stringify(redactionCategories)}`);
  }
  if (skipped > 0) console.log(`skipped (dedupe): ${skipped}`);
  if (opts.embed && (!vectorDb || !embeddings)) {
    console.log(
      "Note: --embed requires configured vectorDb and embeddings. Run storage re-index or wait for background embed to vectorize new facts.",
    );
  } else if (opts.embed && embeddings) {
    console.log(`Embedded ${written} facts using ${embeddings.modelName}`);
  }
  if (opts.synthesize) console.log("Note: --synthesize invokes multi-pass-extractor in a follow-up maintenance job.");
}

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
    delete: (factId: string) => Promise<boolean>;
  },
  embeddings?: { embed: (text: string) => Promise<number[]>; modelName: string },
): void {
  program
    .command("mine <path>")
    .description("Import conversation transcripts as structured memory facts")
    .option("--name <collection>", "Collection name for imported batch")
    .option("--source <format>", "claude-code|chatgpt|claude-ai|slack|text|jsonl")
    .option("--embed", "Generate embeddings after import")
    .option("--synthesize", "Extract decision/preference facts via LLM")
    .option("--dry-run", "Preview without writing")
    .option("--confirm-budget", "Confirm LLM budget for --synthesize")
    .option("--undo <batchId>", "Soft-delete facts from a prior mine batch")
    .option("--scope <scope>", "global, user, agent, or session (default: global)")
    .option("--scope-target <id>", "Scope target id (required for non-global scope)")
    .action(async (path: string, opts: MineOptions & { undo?: string }) => {
      await executeMineCommand(path, opts, factsDb, vectorDb, embeddings);
    });
}
