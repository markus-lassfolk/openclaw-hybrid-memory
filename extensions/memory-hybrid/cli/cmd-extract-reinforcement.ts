/** Reinforcement extraction CLI (`runExtractReinforcementForCli`). Split from cmd-extract.ts. */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ReinforcementContext } from "../backends/facts-db.js";
import {
  getCronModelConfig,
  getDefaultCronModel,
  getLLMModelPreference,
  resolveReflectionModelAndFallbacks,
} from "../config.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "../services/adaptive-maintenance-llm.js";
import { distillMaxOutputTokens } from "../services/chat.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import { capturePluginError } from "../services/error-reporter.js";
import {
  type AnnotationReasons,
  type ReinforcementAnnotationDiagnostic,
  type ReinforcementAnnotationStatus,
  type ReinforcementExtractResult,
  runReinforcementExtract,
} from "../services/reinforcement-extract.js";
import { preFilterSessions } from "../services/session-pre-filter.js";
import { insertRulesUnderSection } from "../services/tools-md-section.js";
import { cleanupEvictedVector } from "../services/vector-maintenance.js";
import { CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import { getEnv } from "../utils/env-manager.js";
import { getReinforcementSignalRegex } from "../utils/language-keywords.js";
import { resolveTierPreferenceWithSources } from "../utils/llm-selection.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { getMaxMtime, getSessionFilePathsSince } from "./cmd-extract-sessions.js";
import { buildPreFilterConfig } from "./cmd-install.js";
import { inferTargetFile } from "./cmd-store.js";
import type { HandlerContext } from "./handlers.js";
import { acquireScanSlot, clearScanLock } from "./shared.js";
export async function runExtractReinforcementForCli(
  ctx: HandlerContext,
  opts: {
    days?: number;
    verbose?: boolean;
    dryRun?: boolean;
    workspace?: string;
    full?: boolean;
  },
): Promise<ReinforcementExtractResult> {
  const { factsDb, vectorDb, embeddings, openai, cfg, proposalsDb, logger } = ctx;
  const SCAN_TYPE = "extract-reinforcement";
  const sessionDir = cfg.procedures.sessionsDir;
  const days = opts.days ?? 3;
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Startup guard + concurrency lock
  if (!opts.full && !opts.dryRun) {
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip)
      return {
        incidents: [],
        sessionsScanned: 0,
        skipped: true,
      } as ReinforcementExtractResult & { skipped?: boolean };
  }

  try {
    let filePaths: string[];
    if (!opts.full && cursor) {
      filePaths = getSessionFilePathsSince(sessionDir, days, cursor.lastSessionTs);
      logger.info?.(`memory-hybrid: ${SCAN_TYPE} incremental — ${filePaths.length} new sessions since last run`);
    } else {
      filePaths = getSessionFilePathsSince(sessionDir, days);
    }
    const workspaceRoot = opts.workspace ?? getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");

    // Two-tier pre-filter: use local Ollama to triage sessions before regex scan (Issue #290).
    // NOTE: filePaths (the full candidate set) is preserved for cursor watermarking below so
    // that skipped sessions still advance the watermark and are not re-triaged on every run.
    let extractionPaths = filePaths;
    const pfCfgReinf = buildPreFilterConfig(cfg);
    if (pfCfgReinf.enabled && filePaths.length > 0) {
      const pfResult = await preFilterSessions(filePaths, pfCfgReinf);
      if (!pfResult.ollamaUnavailable) {
        logger.info?.(
          `memory-hybrid: ${SCAN_TYPE} pre-filter: ${pfResult.kept.length}/${filePaths.length} sessions flagged as interesting`,
        );
        extractionPaths = pfResult.kept;
      } else {
        logger.info?.(`memory-hybrid: ${SCAN_TYPE} pre-filter: Ollama unavailable — scanning all sessions`);
      }
    }

    const reinforcementRegex = getReinforcementSignalRegex();
    const result = await runReinforcementExtract({
      filePaths: extractionPaths,
      reinforcementRegex,
    });

    if (opts.verbose) {
      for (const incident of result.incidents) {
        console.log(
          `[${incident.sessionFile}] Confidence ${incident.confidence.toFixed(
            2,
          )}: ${incident.userMessage.slice(0, 80)}`,
        );
      }
    }

    let llmAnalysisFailed = false;
    const scCfg = cfg.selfCorrection;
    const runLLMAnalysis = scCfg?.reinforcementLLMAnalysis !== false && result.incidents.length > 0 && !opts.dryRun;
    let analysisCategory: string | undefined;

    // LLM analysis step — mirrors self-correction pipeline (#260)
    if (runLLMAnalysis) {
      type ReinforcementRemediation = {
        category: string;
        severity: string;
        remediationType: string;
        remediationContent:
          | string
          | {
              text?: string;
              entity?: string;
              key?: string;
              tags?: string[];
              taskPattern?: string;
              targetFile?: string;
              suggestedChange?: string;
            };
      };
      let analysed: ReinforcementRemediation[] = [];
      try {
        const prompt = fillPrompt(loadPrompt("reinforcement-analyze"), {
          incidents_json: JSON.stringify(result.incidents),
        });
        const extractionTier = cfg.distill?.extractionModelTier ?? "nano";
        const tierPrefWithSources = resolveTierPreferenceWithSources(cfg, extractionTier);
        const cronCfg = getCronModelConfig(cfg);
        const tierPref = getLLMModelPreference(cronCfg, extractionTier);
        const model = tierPref[0] ?? getDefaultCronModel(cronCfg, extractionTier);
        // Derive fallback chain from the full tier preference list; when only one model is
        // configured, fall through to resolveReflectionModelAndFallbacks which picks up
        // llm.fallbackModel and distill.fallbackModels (mirrors the distill/self-correction fix).
        const tierResolved = resolveReflectionModelAndFallbacks(cfg, extractionTier);
        const fallbackModels = tierResolved.fallbackModels ?? [];
        const modelSource =
          tierPrefWithSources.models[0] === model ? (tierPrefWithSources.sources[0] ?? "built-in") : "built-in";
        logger.info?.(`memory-hybrid: extract-reinforcement analysis tier = ${extractionTier}`);
        logger.info?.(
          `memory-hybrid: extract-reinforcement analysis starting with model ${model} (source=${modelSource})`,
        );
        logger.info?.(
          `memory-hybrid: extract-reinforcement analysis fallback chain = [${
            fallbackModels.length > 0 ? fallbackModels.join(", ") : ""
          }]`,
        );
        const adaptiveEnabled = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
        const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
          model,
          modelSource,
          content: prompt,
          temperature: 0.2,
          maxTokens: distillMaxOutputTokens(model),
          openai,
          fallbackModels,
          label: "memory-hybrid: reinforcement analyze",
          feature: CostFeature.extractReinforcement,
          logger,
          adaptiveStatePath:
            ctx.resolvedSqlitePath && ctx.resolvedSqlitePath.length > 0
              ? join(dirname(ctx.resolvedSqlitePath), ".adaptive-llm-limits.json")
              : undefined,
          enabled: adaptiveEnabled,
        });
        if (detail.modelUsed !== model) {
          logger.info?.(
            `memory-hybrid: extract-reinforcement analysis succeeded with fallback model ${detail.modelUsed}`,
          );
        }
        const jsonMatch = detail.content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed)) {
            analysed = parsed as ReinforcementRemediation[];
            analysisCategory = analysed.find((a) => a.category && a.remediationType !== "NO_ACTION")?.category;
          } else {
            llmAnalysisFailed = true;
            logger.warn?.("memory-hybrid: extract-reinforcement analysis produced non-array JSON");
          }
        } else {
          llmAnalysisFailed = true;
          logger.warn?.("memory-hybrid: extract-reinforcement analysis produced no parseable JSON array");
        }
      } catch (e) {
        llmAnalysisFailed = true;
        capturePluginError(e as Error, {
          subsystem: "cli",
          operation: "runExtractReinforcementForCli:llm-analysis",
        });
      }

      const toolsPath = join(workspaceRoot, "TOOLS.md");
      const positiveRulesSection = scCfg?.positiveRulesSection ?? "Positive Reinforcement Rules";
      const semanticThreshold = scCfg?.semanticDedupThreshold ?? 0.92;
      const semanticDedup = scCfg?.semanticDedup !== false;
      const toProposals = scCfg?.reinforcementToProposals !== false;

      for (const a of analysed) {
        if (a.remediationType === "NO_ACTION") continue;
        try {
          if (a.remediationType === "POSITIVE_RULE") {
            const line =
              typeof a.remediationContent === "string"
                ? a.remediationContent
                : ((a.remediationContent as { text?: string })?.text ?? "");
            if (!line.trim()) continue;

            // Exact text dedup: skip if the rule already appears in TOOLS.md
            if (existsSync(toolsPath)) {
              const currentTools = readFileSync(toolsPath, "utf-8");
              if (currentTools.includes(line.trim())) continue;
            }

            // Semantic dedup: skip if a similar rule exists in the vector store (#260)
            let ruleVec: number[] | null = null;
            if (semanticDedup) {
              try {
                ruleVec = await embeddings.embed(line.trim());
                if (await vectorDb.hasDuplicate(ruleVec, semanticThreshold)) {
                  logger?.info?.(
                    `memory-hybrid: reinforcement POSITIVE_RULE skipped (semantic duplicate): ${line.slice(0, 80)}`,
                  );
                  continue;
                }
              } catch (err) {
                capturePluginError(err as Error, {
                  subsystem: "cli",
                  operation: "reinforcement:positive-rule-dedup",
                });
                // Fail open: still insert the rule if dedup check fails
              }
            }

            if (existsSync(toolsPath)) {
              insertRulesUnderSection(toolsPath, positiveRulesSection, [line.trim()]);
              // Store the rule embedding in vector DB for future dedup (#260)
              if (ruleVec) {
                try {
                  await vectorDb.store({
                    text: line.trim(),
                    vector: ruleVec,
                    importance: CLI_STORE_IMPORTANCE,
                    category: "technical",
                    id: `rule-${Date.now()}-${Math.random()}`,
                  });
                } catch (err) {
                  capturePluginError(err as Error, {
                    subsystem: "cli",
                    operation: "reinforcement:positive-rule-store",
                  });
                }
              }
            }
          } else if (a.remediationType === "MEMORY_STORE" || a.remediationType === "PATTERN_FACT") {
            const c = a.remediationContent;
            const isPattern = a.remediationType === "PATTERN_FACT";
            const obj =
              typeof c === "object" && c && "text" in c
                ? (c as {
                    text?: string;
                    entity?: string;
                    key?: string;
                    tags?: string[];
                  })
                : { text: String(c) };
            const text = (obj.text ?? "").trim();
            if (!text || factsDb.hasDuplicate(text, "reinforcement-analysis")) continue;
            let vector: number[] | null = null;
            try {
              vector = await embeddings.embed(text);
              if (semanticDedup && (await vectorDb.hasDuplicate(vector, semanticThreshold))) continue;
            } catch (err) {
              capturePluginError(err as Error, {
                subsystem: "cli",
                operation: "runExtractReinforcementForCli:embed-dedup",
              });
              continue;
            }
            const tags: string[] = Array.isArray(obj.tags) ? obj.tags : [];
            if (isPattern && !tags.includes("reinforcement")) tags.push("reinforcement");
            if (isPattern && !tags.includes("behavioral")) tags.push("behavioral");
            const storeResult = factsDb.storeWithResult({
              text,
              category: isPattern ? "pattern" : "technical",
              importance: CLI_STORE_IMPORTANCE,
              entity: obj.entity ?? null,
              key: typeof obj.key === "string" ? obj.key : null,
              value: text.slice(0, 200),
              source: "reinforcement-analysis",
              tags,
            });
            if (storeResult.skipped) {
              continue;
            }
            const entry = storeResult.entry;
            // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
            await cleanupEvictedVector({
              vectorDb,
              evictedFactId: storeResult.evictedFactId,
              logger: logger,
              context: "extract-reinforcement",
            });
            if (vector) {
              await vectorDb.store({
                text,
                vector,
                importance: CLI_STORE_IMPORTANCE,
                category: isPattern ? "pattern" : "technical",
                id: entry.id,
              });
              factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
            }
          } else if (a.remediationType === "PROCEDURE_BOOST") {
            const c = a.remediationContent;
            const taskPattern =
              typeof c === "object" && c && "taskPattern" in c
                ? String((c as { taskPattern?: string }).taskPattern ?? "")
                : String(c);
            if (taskPattern.trim()) {
              const procs = factsDb.searchProcedures(taskPattern, 3, cfg.distill?.reinforcementProcedureBoost ?? 0.1);
              for (const proc of procs) {
                factsDb.reinforceProcedure(proc.id, taskPattern, cfg.distill?.reinforcementPromotionThreshold ?? 2);
              }
            }
          } else if (a.remediationType === "PROPOSAL" && toProposals && proposalsDb) {
            const c = a.remediationContent;
            const obj = typeof c === "object" && c ? (c as { targetFile?: string; suggestedChange?: string }) : {};
            const suggestedChange = obj.suggestedChange ?? (typeof c === "string" ? c : "");
            const targetFile = obj.targetFile ?? inferTargetFile(suggestedChange);
            if (suggestedChange.trim()) {
              proposalsDb.create({
                targetFile,
                title: `Reinforcement: ${a.category}`,
                observation: "Positive signal from reinforcement analysis",
                suggestedChange: suggestedChange.trim(),
                confidence: 0.7,
                evidenceSessions: result.incidents
                  .map((i) => i.sessionFile)
                  .filter((v, idx, arr) => arr.indexOf(v) === idx),
              });
            }
          }
        } catch (err) {
          capturePluginError(err as Error, {
            subsystem: "cli",
            operation: "runExtractReinforcementForCli:apply-remediation",
          });
        }
      }
    }

    // Annotate facts/procedures with reinforcement if not dry-run
    let annotated = 0;
    const annotationReasons: AnnotationReasons = { noRecalledIds: 0, reinforced: 0, recalledIdsNoMatch: 0, errors: 0 };

    if (!opts.dryRun) {
      const trackContext = cfg.reinforcement?.trackContext !== false;
      const maxEventsPerFact = cfg.reinforcement?.maxEventsPerFact ?? 50;
      for (const incident of result.incidents) {
        if (incident.recalledMemoryIds.length === 0) {
          annotationReasons.noRecalledIds++;
          // Still process procedure boosts even without recalled fact IDs
          try {
            if (incident.toolCallSequence.length >= 2) {
              const taskPattern = incident.toolCallSequence.join(" -> ");
              const procedures = factsDb.searchProcedures(
                taskPattern,
                3,
                cfg.distill?.reinforcementProcedureBoost ?? 0.1,
              );
              for (const proc of procedures) {
                factsDb.reinforceProcedure(
                  proc.id,
                  incident.userMessage,
                  cfg.distill?.reinforcementPromotionThreshold ?? 2,
                );
              }
            }
          } catch (err) {
            annotationReasons.errors++;
            capturePluginError(err as Error, {
              subsystem: "cli",
              operation: "runExtractReinforcementForCli:procedure-boost",
            });
          }
          continue;
        }
        let incidentAnnotated = 0;
        try {
          const context: ReinforcementContext = {
            querySnippet: incident.precedingUserMessage.slice(0, 200) || incident.userMessage.slice(0, 200),
            topic: analysisCategory,
            toolSequence: incident.toolCallSequence.length > 0 ? incident.toolCallSequence : undefined,
            sessionFile: incident.sessionFile,
          };

          // Reinforce recalled memories with rich context, boosted by diversity score (#259)
          const diversityWeight = cfg.reinforcement?.diversityWeight ?? 1.0;
          const baseBoost = cfg.reinforcement?.boostAmount ?? 1.0;
          for (const memId of incident.recalledMemoryIds) {
            const diversityScore = factsDb.calculateDiversityScore(memId);
            const effectiveBoost = baseBoost * (1 - diversityWeight + diversityWeight * diversityScore);
            const reinforced = factsDb.reinforceFact(memId, incident.userMessage, context, {
              trackContext,
              maxEventsPerFact,
              boostAmount: effectiveBoost,
            });
            if (reinforced) {
              incidentAnnotated++;
              annotated++;
            }
          }
        } catch (err) {
          annotationReasons.errors++;
          capturePluginError(err as Error, {
            subsystem: "cli",
            operation: "runExtractReinforcementForCli",
          });
        }
        if (incidentAnnotated > 0) annotationReasons.reinforced++;
        else annotationReasons.recalledIdsNoMatch++;

        // Reinforce procedures based on tool call sequence (separate try-catch to avoid double-counting)
        try {
          if (incident.toolCallSequence.length >= 2) {
            const taskPattern = incident.toolCallSequence.join(" -> ");
            const procedures = factsDb.searchProcedures(
              taskPattern,
              3,
              cfg.distill?.reinforcementProcedureBoost ?? 0.1,
            );
            for (const proc of procedures) {
              factsDb.reinforceProcedure(
                proc.id,
                incident.userMessage,
                cfg.distill?.reinforcementPromotionThreshold ?? 2,
              );
            }
          }
        } catch (err) {
          capturePluginError(err as Error, {
            subsystem: "cli",
            operation: "runExtractReinforcementForCli",
          });
        }
      }
    }

    // Derive annotation status for the incidentsFound > 0 && annotated == 0 case
    let annotationStatus: ReinforcementAnnotationStatus | undefined;
    let annotationDiagnostic: ReinforcementAnnotationDiagnostic | undefined;
    if (!opts.dryRun && result.incidents.length > 0 && annotated === 0) {
      if (llmAnalysisFailed && annotationReasons.noRecalledIds === result.incidents.length) {
        annotationStatus = "degraded_model_or_parser";
      } else if (annotationReasons.errors > 0) {
        annotationStatus = "failed_annotation";
      } else if (annotationReasons.noRecalledIds === result.incidents.length) {
        // All incidents had no recalled memory IDs — agent did not call memory_recall in
        // these sessions. This is expected when sessions don't involve explicit memory recall.
        annotationStatus = "partial_no_matches";
      } else {
        // Some incidents had recalled IDs but none were reinforced (unexpected)
        annotationStatus = "failed_annotation";
      }
    } else if (!opts.dryRun && llmAnalysisFailed && result.incidents.length > 0) {
      // LLM analysis failed but some facts were still reinforced via recalled IDs.
      // Do not override a successful annotation with a failure status — leave undefined.
    }

    if (!opts.dryRun && result.incidents.length > 0 && annotated === 0 && annotationStatus) {
      const noIdsAfterRecall = result.incidents.filter(
        (incident) =>
          incident.recalledMemoryIds.length === 0 &&
          incident.toolCallSequence.some((tool) => tool.toLowerCase() === "memory_recall"),
      ).length;
      if (annotationStatus === "partial_no_matches") {
        if (noIdsAfterRecall > 0) {
          annotationDiagnostic = {
            kind: "missing_recall_metadata",
            summary: `${noIdsAfterRecall}/${result.incidents.length} incident(s) invoked memory_recall but yielded no parseable memory IDs.`,
            recommendedActions: [
              "Inspect memory_recall tool_result payload format and ensure IDs remain visible in session logs.",
              "Run a targeted replay to confirm retrieval output includes canonical UUID IDs.",
            ],
          };
        } else {
          annotationDiagnostic = {
            kind: "expected_sparse_data",
            summary:
              "No incidents included recalled memory IDs; this is expected for sessions without explicit memory recall usage.",
            recommendedActions: [
              "Treat as informational unless recall-heavy sessions also show partial_no_matches.",
              "If recall should have happened, inspect retrieval prompting and memory_recall tool usage in those sessions.",
            ],
          };
        }
      } else if (annotationStatus === "degraded_model_or_parser") {
        annotationDiagnostic = {
          kind: "model_or_parser_degraded",
          summary:
            "LLM analysis failed or returned unparseable output while incidents lacked reinforceable recalled IDs.",
          recommendedActions: [
            "Retry extract-reinforcement after confirming LLM/provider health and parser logs.",
            "If this persists, run with --verbose and inspect reinforcement analysis prompt/response shape.",
          ],
        };
      } else if (annotationReasons.errors > 0) {
        annotationDiagnostic = {
          kind: "annotation_errors",
          summary: `${annotationReasons.errors} incident(s) hit runtime annotation errors.`,
          recommendedActions: [
            "Inspect captured plugin errors for runExtractReinforcementForCli.",
            "Address procedure/fact reinforce exceptions before rerunning extract-reinforcement.",
          ],
        };
      } else if (annotationReasons.recalledIdsNoMatch === result.incidents.length) {
        annotationDiagnostic = {
          kind: "stale_recalled_ids",
          summary: "All recalled memory IDs failed to match active reinforceable facts.",
          recommendedActions: [
            "Audit stale/superseded IDs referenced by memory_recall outputs.",
            "Re-run retrieval against current fact IDs and repair stale recall references.",
          ],
        };
      }
    }

    // Attach annotation results to the returned value
    result.annotated = annotated;
    result.annotationReasons = annotationReasons;
    if (annotationStatus !== undefined) result.annotationStatus = annotationStatus;
    if (annotationDiagnostic) result.annotationDiagnostic = annotationDiagnostic;

    if (!opts.dryRun) {
      const lastSessionTs = getMaxMtime(filePaths);
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, result.sessionsScanned);
    }
    return result;
  } finally {
    if (!opts.full && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}
