/** Daily markdown extraction CLI (`runExtractDailyForCli`). Split from cmd-extract.ts. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryCategory } from "../config.js";
import { getCronModelConfig, getDefaultCronModel } from "../config.js";
import { tryParseCredentialForVault, isStructuredCredentialCandidate } from "../services/auto-capture.js";
import {
  buildCredentialPointerText,
  ensureCredentialVaultPointer,
  abortCredentialVaultWriteOnPointerDedupe,
  rollbackVaultCredentialWrite,
} from "../services/credential-vault-pointer.js";
import { classifyMemoryOperationsBatch, type MemoryClassification } from "../services/classification.js";
import { validateScopedClassificationTarget } from "../services/classification-scope.js";
import { capturePluginError } from "../services/error-reporter.js";
import { extractStructuredFields } from "../services/fact-extraction.js";
import { cleanupEvictedVector, deleteVectorForFactId } from "../services/vector-maintenance.js";
import { findSimilarByEmbedding } from "../services/vector-search.js";
import type { MemoryEntry } from "../types/memory.js";
import { BATCH_STORE_IMPORTANCE } from "../utils/constants.js";
import { formatDateUtc } from "../utils/dates.js";
import { extractTags } from "../utils/tags.js";
import { runMaintenanceHeartbeat } from "./commands/manage/maintenance-heartbeat.js";
import type { HandlerContext } from "./handlers.js";
import type { ExtractDailyResult, ExtractDailySink } from "./types.js";

export async function runExtractDailyForCli(
  ctx: HandlerContext,
  opts: { days: number; dryRun: boolean; verbose?: boolean; force?: boolean; full?: boolean },
  sink: ExtractDailySink,
): Promise<ExtractDailyResult> {
  const { factsDb, vectorDb, embeddings, openai, cfg, credentialsDb, aliasDb, logger } = ctx;
  const memoryDir = join(homedir(), ".openclaw", "memory");
  const daysBack = opts.days;
  let totalExtracted = 0;
  let totalStored = 0;
  let vectorFailures = 0;
  // The default cron path (maintenance-step-runners.ts `buildCliMaintenanceRunners`) substitutes a
  // no-op `sink` for this step, so `sink.warn` alone never reaches the operator's maintenance log.
  // Mirror every warning through `ctx.logger` too — the same channel cmd-distill.ts relies on for
  // its diagnostics — so embedding/vector-store/classification failures survive that substitution.
  const warnDiag = (message: string): void => {
    sink.warn(message);
    logger.warn?.(message);
  };
  const diagLogger = { warn: warnDiag };
  const recordVectorFailure = (err: unknown, operation: string): void => {
    vectorFailures++;
    warnDiag(`memory-hybrid: extract-daily vector store failed: ${err}`);
    capturePluginError(err as Error, {
      subsystem: "cli",
      operation,
    });
  };
  const classifyMicroBatch = Math.max(1, Math.min(10, cfg.autoClassify?.batchSize ?? 10));
  const classifyModelForExtract = cfg.store.classifyModel ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
  type PendingExtractClassify = {
    trimmed: string;
    extracted: ReturnType<typeof extractStructuredFields>;
    category: MemoryCategory;
    storePayload: {
      text: string;
      category: MemoryCategory;
      importance: number;
      entity: string | null;
      key: string | null;
      value: string | null;
      source: `daily-scan:${string}`;
      sourceDate: number;
      tags: string[];
    };
    sourceDateSec: number;
    vecForStore: number[];
    similarFacts: MemoryEntry[];
  };
  const pendingExtractClassify: PendingExtractClassify[] = [];

  async function flushPendingExtractClassify(): Promise<void> {
    while (pendingExtractClassify.length > 0) {
      const chunk = pendingExtractClassify.splice(0, classifyMicroBatch);
      const inputs = chunk.map((c) => ({
        candidateText: c.trimmed,
        candidateEntity: c.extracted.entity,
        candidateKey: c.extracted.key,
        existingFacts: c.similarFacts,
      }));
      const results = await classifyMemoryOperationsBatch(inputs, openai, classifyModelForExtract, diagLogger);
      for (let j = 0; j < chunk.length; j++) {
        const c = chunk[j];
        const classification: MemoryClassification = results[j];
        const { trimmed, extracted, category, storePayload, sourceDateSec, vecForStore } = c;
        if (classification.action === "NOOP") continue;
        if (classification.action === "DELETE" && classification.targetId) {
          const target = validateScopedClassificationTarget({
            targetId: classification.targetId,
            candidates: c.similarFacts,
            getById: (id) => factsDb.getById(id),
            scope: "global",
            scopeTarget: null,
            warn: warnDiag,
            warnMessage: `memory-hybrid: blocked cross-scope or unknown extract-daily DELETE target ${classification.targetId}`,
          });
          if (target) {
            factsDb.supersede(classification.targetId, null);
            aliasDb?.deleteByFactId(classification.targetId);
            await deleteVectorForFactId({
              vectorDb,
              factId: classification.targetId,
              logger: diagLogger,
              context: "extract-daily-delete-action",
            });
          }
          continue;
        }
        if (classification.action === "UPDATE" && classification.targetId) {
          const oldFact = validateScopedClassificationTarget({
            targetId: classification.targetId,
            candidates: c.similarFacts,
            getById: (id) => factsDb.getById(id),
            scope: "global",
            scopeTarget: null,
            warn: warnDiag,
            warnMessage: `memory-hybrid: blocked cross-scope extract-daily UPDATE target ${classification.targetId}`,
          });
          if (oldFact) {
            const storeResult = factsDb.storeWithResult({
              ...storePayload,
              entity: extracted.entity ?? oldFact.entity,
              key: extracted.key ?? oldFact.key,
              value: extracted.value ?? oldFact.value,
              validFrom: sourceDateSec,
              supersedesId: classification.targetId,
            });
            if (storeResult.skipped) {
              continue;
            }
            if (storeResult.newlyStored === false && !storeResult.embeddingStale) {
              continue;
            }
            const newEntry = storeResult.entry;
            // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
            await cleanupEvictedVector({
              vectorDb,
              evictedFactId: storeResult.evictedFactId,
              logger: diagLogger,
              context: "extract-daily-update",
            });
            if (storeResult.newlyStored) {
              factsDb.supersede(classification.targetId, newEntry.id);
              aliasDb?.deleteByFactId(classification.targetId);
              await deleteVectorForFactId({
                vectorDb,
                factId: classification.targetId,
                logger: diagLogger,
                context: "extract-daily-update-superseded",
              });
            }
            try {
              factsDb.setEmbeddingModel(newEntry.id, embeddings.modelName);
              if (!(await vectorDb.hasDuplicate(vecForStore))) {
                await vectorDb.store({
                  text: trimmed,
                  vector: vecForStore,
                  importance: BATCH_STORE_IMPORTANCE,
                  category,
                  id: newEntry.id,
                });
              }
            } catch (err) {
              recordVectorFailure(err, "runExtractDailyForCli:vector-store-update");
            }
            totalStored++;
            continue;
          }
        }
        const storeResult = factsDb.storeWithResult(storePayload);
        if (storeResult.skipped) {
          continue;
        }
        if (storeResult.newlyStored === false && !storeResult.embeddingStale) {
          continue;
        }
        const entry = storeResult.entry;
        // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
        await cleanupEvictedVector({
          vectorDb,
          evictedFactId: storeResult.evictedFactId,
          logger: diagLogger,
          context: "extract-daily",
        });
        try {
          const vector = vecForStore;
          factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
          if (!(await vectorDb.hasDuplicate(vector))) {
            await vectorDb.store({
              text: trimmed,
              vector,
              importance: BATCH_STORE_IMPORTANCE,
              category,
              id: entry.id,
            });
          }
        } catch (err) {
          recordVectorFailure(err, "runExtractDailyForCli:vector-store-final");
        }
        totalStored++;
      }
    }
  }

  let daysProcessed = 0;
  await runMaintenanceHeartbeat(
    "extract-daily",
    opts.verbose === true,
    async () => {
      for (let d = 0; d < daysBack; d++) {
        const date = new Date();
        date.setDate(date.getDate() - d);
        const dateStr = formatDateUtc(Math.floor(date.getTime() / 1000));
        const filePath = join(memoryDir, `${dateStr}.md`);
        if (!existsSync(filePath)) continue;
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter((l: string) => l.trim().length > 10);
        sink.log(`\nScanning ${dateStr} (${lines.length} lines)...`);
        for (const line of lines) {
          const trimmed = line.replace(/^[-*#>\s]+/, "").trim();
          if (trimmed.length < 15 || trimmed.length > 500) continue;
          const category = ctx.detectCategory(trimmed);
          const extracted = extractStructuredFields(trimmed, category);
          const parsed = tryParseCredentialForVault(trimmed, extracted.entity, extracted.key, extracted.value, {
            requirePatternMatch: cfg.credentials.autoCapture?.requirePatternMatch === true,
          });
          if (parsed) {
            if (cfg.credentials.enabled && credentialsDb) {
              totalExtracted++;
              if (!opts.dryRun) {
                let storedInVault = false;
                try {
                  storedInVault = credentialsDb.storeIfNew({
                    service: parsed.service,
                    type: parsed.type,
                    value: parsed.secretValue,
                    url: parsed.url,
                    notes: parsed.notes,
                  }) != null;
                  const sourceDateSec = Math.floor(new Date(dateStr).getTime() / 1000);
                  const pointer = ensureCredentialVaultPointer(
                    factsDb,
                    parsed.service,
                    parsed.type,
                    `daily-scan:${dateStr}`,
                    {
                      importance: BATCH_STORE_IMPORTANCE,
                      sourceDate: sourceDateSec,
                    },
                  );
                  if (!pointer.ok) {
                    if (storedInVault) {
                      rollbackVaultCredentialWrite(credentialsDb, parsed.service, parsed.type);
                    }
                    continue;
                  }
                  if (
                    abortCredentialVaultWriteOnPointerDedupe(
                      storedInVault,
                      pointer,
                      credentialsDb,
                      parsed.service,
                      parsed.type,
                    )
                  ) {
                    continue;
                  }
                  const pointerEntry = pointer.entry;
                  await cleanupEvictedVector({
                    vectorDb,
                    evictedFactId: pointer.evictedFactId,
                    logger: diagLogger,
                    context: "extract-daily-credential-pointer",
                  });
                  if (pointer.newlyStored || pointer.embeddingStale) {
                    const pointerText = buildCredentialPointerText(parsed.service, parsed.type);
                    try {
                      const vector = await embeddings.embed(pointerText);
                      factsDb.setEmbeddingModel(pointerEntry.id, embeddings.modelName);
                      if (!(await vectorDb.hasDuplicate(vector))) {
                        await vectorDb.store({
                          text: pointerText,
                          vector,
                          importance: BATCH_STORE_IMPORTANCE,
                          category: "technical",
                          id: pointerEntry.id,
                        });
                      }
                    } catch (err) {
                      recordVectorFailure(err, "runExtractDailyForCli:vector-store");
                    }
                  }
                  totalStored++;
                } catch (err) {
                  if (storedInVault) {
                    rollbackVaultCredentialWrite(credentialsDb, parsed.service, parsed.type);
                  }
                  capturePluginError(err as Error, {
                    subsystem: "cli",
                    operation: "runExtractDailyForCli:credential-store",
                  });
                }
              }
              continue;
            }
            if (opts.verbose) sink.log("  skipped credential-like line: vault disabled or unavailable");
            continue;
          }

          // When requirePatternMatch rejects vault parsing but the input is still credential-like,
          // skip ordinary storage to prevent plaintext secrets in facts.db (#1896).
          if (
            !parsed &&
            cfg.credentials.autoCapture?.requirePatternMatch === true &&
            isStructuredCredentialCandidate(trimmed, extracted.entity, extracted.key, extracted.value)
          ) {
            if (opts.verbose) sink.log("  skipped credential-like line: blocked by requirePatternMatch");
            continue;
          }

          if (!extracted.entity && !extracted.key && category !== "decision") continue;
          totalExtracted++;
          if (opts.dryRun) {
            sink.log(
              `  [${category}] ${extracted.entity || "?"} / ${
                extracted.key || "?"
              } = ${extracted.value || trimmed.slice(0, 60)}`,
            );
            continue;
          }
          if (factsDb.hasDuplicate(trimmed, `daily-scan:${dateStr}`)) continue;
          const sourceDateSec = Math.floor(new Date(dateStr).getTime() / 1000);
          const storePayload = {
            text: trimmed,
            category,
            importance: BATCH_STORE_IMPORTANCE,
            entity: extracted.entity,
            key: extracted.key,
            value: extracted.value,
            source: `daily-scan:${dateStr}` as const,
            sourceDate: sourceDateSec,
            tags: extractTags(trimmed, extracted.entity),
          };
          let vecForStore: number[] | undefined;
          if (cfg.store.classifyBeforeWrite) {
            try {
              vecForStore = await embeddings.embed(trimmed);
            } catch (err) {
              warnDiag(`memory-hybrid: extract-daily embedding failed: ${err}`);
              capturePluginError(err as Error, {
                subsystem: "cli",
                operation: "runExtractDailyForCli:embed",
              });
            }
            if (vecForStore) {
              let similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vecForStore, 3, 0.3, {
                scope: "global",
                scopeTarget: null,
              });
              if (similarFacts.length === 0) {
                similarFacts = factsDb.findSimilarForClassification(
                  trimmed,
                  extracted.entity,
                  extracted.key,
                  3,
                  "global",
                  null,
                );
              }
              if (similarFacts.length > 0) {
                pendingExtractClassify.push({
                  trimmed,
                  extracted,
                  category,
                  storePayload,
                  sourceDateSec,
                  vecForStore,
                  similarFacts,
                });
                if (pendingExtractClassify.length >= classifyMicroBatch) await flushPendingExtractClassify();
                continue;
              }
            }
          }
          await flushPendingExtractClassify();
          const storeResult = factsDb.storeWithResult(storePayload);
          if (storeResult.skipped) {
            continue;
          }
          if (storeResult.newlyStored === false && !storeResult.embeddingStale) {
            continue;
          }
          const entry = storeResult.entry;
          await cleanupEvictedVector({
            vectorDb,
            evictedFactId: storeResult.evictedFactId,
            logger: diagLogger,
            context: "extract-daily",
          });
          try {
            const vector = vecForStore ?? (await embeddings.embed(trimmed));
            factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
            if (!(await vectorDb.hasDuplicate(vector))) {
              await vectorDb.store({
                text: trimmed,
                vector,
                importance: BATCH_STORE_IMPORTANCE,
                category,
                id: entry.id,
              });
            }
          } catch (err) {
            recordVectorFailure(err, "runExtractDailyForCli:vector-store-final");
          }
          totalStored++;
        }
        await flushPendingExtractClassify();
        daysProcessed = d + 1;
      }
      await flushPendingExtractClassify();
    },
    {
      progressSupplier: () =>
        `days=${daysProcessed}/${daysBack} extracted=${totalExtracted} stored=${totalStored}`,
    },
  );
  const semanticOutcome = vectorFailures > 0 ? "partial" : "success";
  return { totalExtracted, totalStored, daysBack, dryRun: opts.dryRun, vectorFailures, semanticOutcome };
}
