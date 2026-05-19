/**
 * Extract CLI — split from cmd-extract.ts.
 */
import { getEnv } from "../utils/env-manager.js";
/**
 * Extract CLI Handler Functions
 *
 * Contains scan state, session helpers, and the following handlers:
 *   runExtractProceduresForCli, runGenerateAutoSkillsForCli,
 *   runExtractDirectivesForCli, runExtractReinforcementForCli,
 *   runGenerateProposalsForCli, runExtractDailyForCli.
 * Extracted from handlers.ts.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ReinforcementContext } from "../backends/facts-db.js";
import type { MemoryCategory } from "../config.js";
import {
  getCronModelConfig,
  getDefaultCronModel,
  getLLMModelPreference,
  resolveReflectionModelAndFallbacks,
} from "../config.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "../services/adaptive-maintenance-llm.js";
import { VAULT_POINTER_PREFIX, isCredentialLike, tryParseCredentialForVault } from "../services/auto-capture.js";
import { chatCompleteWithRetryDetailed, distillMaxOutputTokens } from "../services/chat.js";
import { validateScopedClassificationTarget } from "../services/classification-scope.js";
import { type MemoryClassification, classifyMemoryOperationsBatch } from "../services/classification.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import { shouldReportVectorDedupeFallback } from "../services/dedupe-policy.js";
import { type DirectiveExtractResult, runDirectiveExtract } from "../services/directive-extract.js";
import { capturePluginError } from "../services/error-reporter.js";
import { extractStructuredFields } from "../services/fact-extraction.js";
import { runIdentityReflection } from "../services/identity-reflection.js";
import {
  buildPersonaStateInsightsBlock,
  promotePersonaStateFromReflections,
} from "../services/persona-state-promotion.js";
import { extractProceduresFromSessions } from "../services/procedure-extractor.js";
import { generateAutoSkills } from "../services/procedure-skill-generator.js";
import { type ReinforcementExtractResult, runReinforcementExtract } from "../services/reinforcement-extract.js";
import { preFilterSessions } from "../services/session-pre-filter.js";
import { insertRulesUnderSection } from "../services/tools-md-section.js";
import { cleanupEvictedVector, deleteVectorForFactId } from "../services/vector-maintenance.js";
import { findSimilarByEmbedding } from "../services/vector-search.js";
import type { MemoryEntry } from "../types/memory.js";
import { BATCH_STORE_IMPORTANCE, CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import { getFileSnapshot } from "../utils/file-snapshot.js";
import { getDirectiveSignalRegex, getReinforcementSignalRegex } from "../utils/language-keywords.js";
import { resolveTierPreferenceWithSources } from "../utils/llm-selection.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { extractTags } from "../utils/tags.js";
import { buildPreFilterConfig } from "./cmd-install.js";
import { inferTargetFile } from "./cmd-store.js";
import type { HandlerContext } from "./handlers.js";
import { capProposalConfidence } from "./proposals.js";
import { acquireScanSlot, clearScanLock } from "./shared.js";
import type {
  ExtractDailyResult,
  ExtractDailySink,
  ExtractProceduresResult,
  GenerateAutoSkillsResult,
} from "./types.js";

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
                  type: parsed.type as any,
                  value: parsed.secretValue,
                  url: parsed.url,
                  notes: parsed.notes,
                });
                if (!stored) {
                  continue;
                }
                storedInVault = true;
                const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
                const sourceDateSec = Math.floor(new Date(dateStr).getTime() / 1000);
                const pointerEntry = factsDb.store({
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
                    credentialsDb.delete(parsed.service, parsed.type as any);
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
      const entry = factsDb.store(storePayload);
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
