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

import { existsSync, readFileSync, } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ReinforcementContext } from "../backends/facts-db.js";
import {
  getCronModelConfig,
  getDefaultCronModel,
  getLLMModelPreference,
} from "../config.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "../services/adaptive-maintenance-llm.js";
import { distillMaxOutputTokens } from "../services/chat.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import { capturePluginError } from "../services/error-reporter.js";
import { type ReinforcementExtractResult, runReinforcementExtract } from "../services/reinforcement-extract.js";
import { preFilterSessions } from "../services/session-pre-filter.js";
import { insertRulesUnderSection } from "../services/tools-md-section.js";
import { cleanupEvictedVector, } from "../services/vector-maintenance.js";
import { CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import { getReinforcementSignalRegex } from "../utils/language-keywords.js";
import { resolveTierPreferenceWithSources } from "../utils/llm-selection.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { buildPreFilterConfig } from "./cmd-install.js";
import { inferTargetFile } from "./cmd-store.js";
import type { HandlerContext } from "./handlers.js";
import { acquireScanSlot, clearScanLock } from "./shared.js";

import { getSessionFilePathsSince, getMaxMtime } from "./cmd-extract-sessions.js";
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
        const tierPrefWithSources = resolveTierPreferenceWithSources(
          cfg,
          extractionTier as "nano" | "default" | "heavy",
        );
        const cronCfg = getCronModelConfig(cfg);
        const tierPref = getLLMModelPreference(cronCfg, extractionTier);
        const model = tierPref[0] ?? getDefaultCronModel(cronCfg, extractionTier);
        const fallbackModels = tierPref.length > 1 ? tierPref.slice(1) : (cfg.distill?.fallbackModels ?? []);
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
          analysed = JSON.parse(jsonMatch[0]) as ReinforcementRemediation[];
          analysisCategory = analysed.find((a) => a.category && a.remediationType !== "NO_ACTION")?.category;
        }
      } catch (e) {
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
    if (!opts.dryRun) {
      const trackContext = cfg.reinforcement?.trackContext !== false;
      const maxEventsPerFact = cfg.reinforcement?.maxEventsPerFact ?? 50;
      for (const incident of result.incidents) {
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
            factsDb.reinforceFact(memId, incident.userMessage, context, {
              trackContext,
              maxEventsPerFact,
              boostAmount: effectiveBoost,
            });
          }

          // Reinforce procedures based on tool call sequence
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

    if (!opts.dryRun) {
      const lastSessionTs = getMaxMtime(filePaths);
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, result.sessionsScanned);
    }
    return result;
  } finally {
    if (!opts.full && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}

/**
 * Generate persona proposals from reflection insights (patterns, rules, meta).
 * Reads identity files, calls LLM to find gaps, creates proposals in DB (fixes #81).
 */
