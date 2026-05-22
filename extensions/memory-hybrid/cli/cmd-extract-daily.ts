/** Daily markdown extraction CLI (`runExtractDailyForCli`). Split from cmd-extract.ts. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryCategory } from "../config.js";
import { getCronModelConfig, getDefaultCronModel } from "../config.js";
import { isCredentialLike, tryParseCredentialForVault, VAULT_POINTER_PREFIX } from "../services/auto-capture.js";
import { classifyMemoryOperationsBatch, type MemoryClassification } from "../services/classification.js";
import { validateScopedClassificationTarget } from "../services/classification-scope.js";
import { capturePluginError } from "../services/error-reporter.js";
import { extractStructuredFields } from "../services/fact-extraction.js";
import { cleanupEvictedVector, deleteVectorForFactId } from "../services/vector-maintenance.js";
import { findSimilarByEmbedding } from "../services/vector-search.js";
import type { MemoryEntry } from "../types/memory.js";
import { BATCH_STORE_IMPORTANCE } from "../utils/constants.js";
import { extractTags } from "../utils/tags.js";
import type { HandlerContext } from "./handlers.js";
import type { ExtractDailyResult, ExtractDailySink } from "./types.js";

export async function runExtractDailyForCli(
  ctx: HandlerContext,
  opts: { days: number; dryRun: boolean; verbose?: boolean },
  sink: ExtractDailySink,
): Promise<ExtractDailyResult> {
  const { factsDb, vectorDb, embeddings, openai, cfg, credentialsDb, aliasDb } = ctx;
  const memoryDir = join(homedir(), ".openclaw", "memory");
  const daysBack = opts.days;
  let totalExtracted = 0;
  let totalStored = 0;
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
      const results = await classifyMemoryOperationsBatch(inputs, openai, classifyModelForExtract, sink);
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
            warn: (message) => sink.warn(message),
            warnMessage: `memory-hybrid: blocked cross-scope or unknown extract-daily DELETE target ${classification.targetId}`,
          });
          if (target) {
            factsDb.supersede(classification.targetId, null);
            aliasDb?.deleteByFactId(classification.targetId);
            await deleteVectorForFactId({
              vectorDb,
              factId: classification.targetId,
              logger: sink,
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
            warn: (message) => sink.warn(message),
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
            const newEntry = storeResult.entry;
            // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
            await cleanupEvictedVector({
              vectorDb,
              evictedFactId: storeResult.evictedFactId,
              logger: sink,
              context: "extract-daily-update",
            });
            factsDb.supersede(classification.targetId, newEntry.id);
            aliasDb?.deleteByFactId(classification.targetId);
            await deleteVectorForFactId({
              vectorDb,
              factId: classification.targetId,
              logger: sink,
              context: "extract-daily-update-superseded",
            });
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
              sink.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
              capturePluginError(err as Error, {
                subsystem: "cli",
                operation: "runExtractDailyForCli:vector-store-update",
              });
            }
            totalStored++;
            continue;
          }
        }
        const storeResult = factsDb.storeWithResult(storePayload);
        if (storeResult.skipped) {
          continue;
        }
        const entry = storeResult.entry;
        // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
        await cleanupEvictedVector({
          vectorDb,
          evictedFactId: storeResult.evictedFactId,
          logger: sink,
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
          sink.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
          capturePluginError(err as Error, {
            subsystem: "cli",
            operation: "runExtractDailyForCli:vector-store-final",
          });
        }
        totalStored++;
      }
    }
  }

  for (let d = 0; d < daysBack; d++) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().split("T")[0];
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
      if (isCredentialLike(trimmed, extracted.entity, extracted.key, extracted.value)) {
        if (cfg.credentials.enabled && credentialsDb) {
          const parsed = tryParseCredentialForVault(trimmed, extracted.entity, extracted.key, extracted.value, {
            requirePatternMatch: cfg.credentials.autoCapture?.requirePatternMatch === true,
          });
          if (parsed) {
            totalExtracted++;
            if (!opts.dryRun) {
              let storedInVault = false;
              try {
                const stored = credentialsDb.storeIfNew({
                  service: parsed.service,
                  type: parsed.type,
                  value: parsed.secretValue,
                  url: parsed.url,
                  notes: parsed.notes,
                });
                if (!stored) {
                  continue;
                }
                storedInVault = true;
                const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}", type="${parsed.type}") to retrieve.`;
                const sourceDateSec = Math.floor(new Date(dateStr).getTime() / 1000);
                const pointerStoreResult = factsDb.storeWithResult({
                  text: pointerText,
                  category: "technical",
                  importance: BATCH_STORE_IMPORTANCE,
                  entity: "Credentials",
                  key: parsed.service,
                  value: `${VAULT_POINTER_PREFIX}${parsed.service}:${parsed.type}`,
                  source: `daily-scan:${dateStr}`,
                  sourceDate: sourceDateSec,
                  tags: ["auth", ...extractTags(pointerText, "Credentials")],
                });
                if (pointerStoreResult.skipped) {
                  continue;
                }
                const pointerEntry = pointerStoreResult.entry;
                await cleanupEvictedVector({
                  vectorDb,
                  evictedFactId: pointerStoreResult.evictedFactId,
                  logger: sink,
                  context: "extract-daily-credential-pointer",
                });
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
                  sink.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
                  capturePluginError(err as Error, {
                    subsystem: "cli",
                    operation: "runExtractDailyForCli:vector-store",
                  });
                }
                totalStored++;
              } catch (err) {
                if (storedInVault) {
                  try {
                    credentialsDb.delete(parsed.service, parsed.type);
                  } catch (cleanupErr) {
                    sink.warn(
                      `memory-hybrid: Failed to clean up orphaned credential for ${parsed.service}: ${cleanupErr}`,
                    );
                    capturePluginError(cleanupErr as Error, {
                      subsystem: "cli",
                      operation: "runExtractDailyForCli:credential-compensating-delete",
                    });
                  }
                }
                capturePluginError(err as Error, {
                  subsystem: "cli",
                  operation: "runExtractDailyForCli:credential-store",
                });
              }
            }
            // Skip normal fact-storage path — this line has been handled as a credential.
            continue;
          }
          // isCredentialLike but vault parse failed — skip this line entirely.
          continue;
        }
        if (opts.verbose) sink.log("  skipped credential-like line: vault disabled or unavailable");
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
          sink.warn(`memory-hybrid: extract-daily embedding failed: ${err}`);
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
      const entry = storeResult.entry;
      await cleanupEvictedVector({
        vectorDb,
        evictedFactId: storeResult.evictedFactId,
        logger: sink,
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
        sink.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
        capturePluginError(err as Error, {
          subsystem: "cli",
          operation: "runExtractDailyForCli:vector-store-final",
        });
      }
      totalStored++;
    }
    await flushPendingExtractClassify();
  }
  await flushPendingExtractClassify();
  return { totalExtracted, totalStored, daysBack, dryRun: opts.dryRun };
}
