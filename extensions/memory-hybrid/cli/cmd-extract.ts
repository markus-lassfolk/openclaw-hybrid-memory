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
import { join } from "node:path";

import type { ReinforcementContext } from "../backends/facts-db.js";
import type { HybridMemoryConfig, MemoryCategory } from "../config.js";
import {
  getCronModelConfig,
  getDefaultCronModel,
  getLLMModelPreference,
  resolveReflectionModelAndFallbacks,
} from "../config.js";
import { VAULT_POINTER_PREFIX, isCredentialLike, tryParseCredentialForVault } from "../services/auto-capture.js";
import { chatCompleteWithRetry, distillMaxOutputTokens } from "../services/chat.js";
import { type MemoryClassification, classifyMemoryOperationsBatch } from "../services/classification.js";
import { CostFeature } from "../services/cost-feature-labels.js";
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
import { findSimilarByEmbedding } from "../services/vector-search.js";
import type { MemoryEntry } from "../types/memory.js";
import { BATCH_STORE_IMPORTANCE, CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import { getFileSnapshot } from "../utils/file-snapshot.js";
import { getDirectiveSignalRegex, getReinforcementSignalRegex } from "../utils/language-keywords.js";
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

/**
 * Returns session .jsonl file paths modified within the last `days` days,
 * or — when `sinceTimestamp` is provided — modified strictly after that epoch-ms.
 * Shared by procedure/directive/reinforcement extraction.
 */
export function getSessionFilePathsSince(sessionDir: string, days: number, sinceTimestamp?: number): string[] {
  if (!existsSync(sessionDir)) return [];
  const cutoff = sinceTimestamp !== undefined ? sinceTimestamp : Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    const files = readdirSync(sessionDir);
    return files
      .filter((f) => f.endsWith(".jsonl") && !f.startsWith(".deleted"))
      .map((f) => join(sessionDir, f))
      .filter((p) => {
        try {
          return statSync(p).mtimeMs > cutoff;
        } catch (err) {
          capturePluginError(err as Error, {
            operation: "stat-check",
            severity: "info",
            subsystem: "cli",
          });
          return false;
        }
      });
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "getSessionFilePathsSince" });
    return [];
  }
}

/**
 * Returns the maximum mtime (in epoch-ms) of the given file paths, or undefined if none exist.
 * Used to track the newest session timestamp for scan cursors.
 */
export function getMaxMtime(filePaths: string[]): number | undefined {
  let maxMtime: number | undefined;
  for (const p of filePaths) {
    try {
      const mtime = statSync(p).mtimeMs;
      if (maxMtime === undefined || mtime > maxMtime) {
        maxMtime = mtime;
      }
    } catch (_err) {
      // Ignore files that can't be stat'd
    }
  }
  return maxMtime;
}

/**
 * Extract procedures from sessions
 */
export async function runExtractProceduresForCli(
  ctx: HandlerContext,
  opts: { sessionDir?: string; days?: number; dryRun: boolean; verbose?: boolean; full?: boolean },
): Promise<ExtractProceduresResult> {
  const { factsDb, cfg, logger } = ctx;
  const SCAN_TYPE = "extract-procedures";
  if (cfg.procedures?.enabled === false) {
    return { sessionsScanned: 0, proceduresStored: 0, positiveCount: 0, negativeCount: 0, dryRun: opts.dryRun };
  }
  const sessionDir = opts.sessionDir ?? cfg.procedures.sessionsDir;
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Startup guard + concurrency lock (skip when not full mode)
  if (!opts.full && !opts.dryRun) {
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip)
      return {
        sessionsScanned: 0,
        proceduresStored: 0,
        positiveCount: 0,
        negativeCount: 0,
        dryRun: false,
        skipped: true,
      };
  }

  let filePaths: string[] | undefined;
  if (!opts.full && cursor) {
    // Incremental: only sessions modified after the last processed session timestamp
    filePaths = getSessionFilePathsSince(sessionDir, opts.days ?? 7, cursor.lastSessionTs);
    logger.info?.(`memory-hybrid: ${SCAN_TYPE} incremental — ${filePaths.length} new sessions since last run`);
  } else if (opts.days != null && opts.days > 0) {
    filePaths = getSessionFilePathsSince(sessionDir, opts.days);
  }

  try {
    const result = await extractProceduresFromSessions(
      factsDb,
      {
        sessionDir: filePaths ? undefined : sessionDir,
        filePaths,
        minSteps: cfg.procedures.minSteps,
        dryRun: opts.dryRun,
        verbose: opts.verbose,
      },
      { info: (s) => logger.info?.(s) ?? console.log(s), warn: (s) => logger.warn?.(s) ?? console.warn(s) },
    );
    if (!opts.dryRun) {
      let lastSessionTs: number | undefined;
      if (filePaths) {
        lastSessionTs = getMaxMtime(filePaths);
      } else {
        const allFiles = getSessionFilePathsSince(sessionDir, 0, 0);
        lastSessionTs = getMaxMtime(allFiles);
      }
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, result.sessionsScanned);
    }
    return result;
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractProceduresForCli" });
    throw err;
  } finally {
    if (!opts.full && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}

/**
 * Generate auto-skills from procedures
 */
export async function runGenerateAutoSkillsForCli(
  ctx: HandlerContext,
  opts: { dryRun: boolean; verbose?: boolean },
): Promise<GenerateAutoSkillsResult> {
  const { factsDb, cfg, logger } = ctx;
  const info = opts.verbose ? (s: string) => logger.info?.(s) ?? console.log(s) : () => {};
  const warn = (s: string) => logger.warn?.(s) ?? console.warn(s);
  try {
    return generateAutoSkills(
      factsDb,
      {
        skillsAutoPath: cfg.procedures.skillsAutoPath,
        validationThreshold: cfg.procedures.validationThreshold,
        skillTTLDays: cfg.procedures.skillTTLDays,
        dryRun: opts.dryRun,
      },
      { info, warn },
    );
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runGenerateAutoSkillsForCli" });
    throw err;
  }
}

/**
 * Extract directives from sessions
 */
export async function runExtractDirectivesForCli(
  ctx: HandlerContext,
  opts: { days?: number; verbose?: boolean; dryRun?: boolean; full?: boolean },
): Promise<DirectiveExtractResult & { stored?: number }> {
  const { factsDb, cfg, logger } = ctx;
  const SCAN_TYPE = "extract-directives";
  const sessionDir = cfg.procedures.sessionsDir;
  const days = opts.days ?? 3;
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Startup guard + concurrency lock (skip when not full mode)
  if (!opts.full && !opts.dryRun) {
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip)
      return { incidents: [], sessionsScanned: 0, stored: 0, skipped: true } as DirectiveExtractResult & {
        stored?: number;
        skipped?: boolean;
      };
  }

  try {
    let filePaths: string[];
    if (!opts.full && cursor) {
      filePaths = getSessionFilePathsSince(sessionDir, days, cursor.lastSessionTs);
      logger.info?.(`memory-hybrid: ${SCAN_TYPE} incremental — ${filePaths.length} new sessions since last run`);
    } else {
      filePaths = getSessionFilePathsSince(sessionDir, days);
    }

    // Two-tier pre-filter: use local Ollama to triage sessions before regex scan (Issue #290).
    // NOTE: filePaths (the full candidate set) is preserved for cursor watermarking below so
    // that skipped sessions still advance the watermark and are not re-triaged on every run.
    let extractionPaths = filePaths;
    const pfCfgDir = buildPreFilterConfig(cfg);
    if (pfCfgDir.enabled && filePaths.length > 0) {
      const pfResult = await preFilterSessions(filePaths, pfCfgDir);
      if (!pfResult.ollamaUnavailable) {
        logger.info?.(
          `memory-hybrid: ${SCAN_TYPE} pre-filter: ${pfResult.kept.length}/${filePaths.length} sessions flagged as interesting`,
        );
        extractionPaths = pfResult.kept;
      } else {
        logger.info?.(`memory-hybrid: ${SCAN_TYPE} pre-filter: Ollama unavailable — scanning all sessions`);
      }
    }

    const directiveRegex = getDirectiveSignalRegex();
    const result = runDirectiveExtract({ filePaths: extractionPaths, directiveRegex });

    if (opts.verbose) {
      for (const incident of result.incidents) {
        console.log(`[${incident.sessionFile}] ${incident.categories.join(", ")}: ${incident.extractedRule}`);
      }
    }

    // Store directives as facts if not dry-run
    let stored = 0;
    if (!opts.dryRun) {
      for (const incident of result.incidents) {
        try {
          if (factsDb.hasDuplicate(incident.extractedRule)) continue;
          const category = incident.categories.includes("preference")
            ? "preference"
            : incident.categories.includes("absolute_rule")
              ? "rule"
              : incident.categories.includes("conditional_rule")
                ? "rule"
                : incident.categories.includes("warning")
                  ? "rule"
                  : incident.categories.includes("future_behavior")
                    ? "rule"
                    : incident.categories.includes("procedural")
                      ? "pattern"
                      : incident.categories.includes("correction")
                        ? "decision"
                        : incident.categories.includes("implicit_correction")
                          ? "decision"
                          : incident.categories.includes("explicit_memory")
                            ? "fact"
                            : "other";
          factsDb.store({
            text: incident.extractedRule,
            category: category as MemoryCategory,
            importance: 0.8,
            entity: null,
            key: null,
            value: null,
            source: `directive:${incident.sessionFile}`,
            confidence: incident.confidence,
          });
          stored++;
        } catch (err) {
          capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractDirectivesForCli:store" });
        }
      }
    }

    const returnVal = { ...result, stored };
    if (!opts.dryRun) {
      const lastSessionTs = getMaxMtime(filePaths);
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, result.sessionsScanned);
    }
    return returnVal;
  } finally {
    if (!opts.full && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}

/**
 * Extract reinforcement signals from sessions
 */
export async function runExtractReinforcementForCli(
  ctx: HandlerContext,
  opts: { days?: number; verbose?: boolean; dryRun?: boolean; workspace?: string; full?: boolean },
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
      return { incidents: [], sessionsScanned: 0, skipped: true } as ReinforcementExtractResult & { skipped?: boolean };
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
    const result = await runReinforcementExtract({ filePaths: extractionPaths, reinforcementRegex });

    if (opts.verbose) {
      for (const incident of result.incidents) {
        console.log(
          `[${incident.sessionFile}] Confidence ${incident.confidence.toFixed(2)}: ${incident.userMessage.slice(0, 80)}`,
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
        const cronCfg = getCronModelConfig(cfg);
        const tierPref = getLLMModelPreference(cronCfg, extractionTier);
        const model = tierPref[0] ?? getDefaultCronModel(cronCfg, extractionTier);
        const fallbackModels = tierPref.length > 1 ? tierPref.slice(1) : (cfg.distill?.fallbackModels ?? []);
        const content = await chatCompleteWithRetry({
          model,
          content: prompt,
          temperature: 0.2,
          maxTokens: distillMaxOutputTokens(model),
          openai,
          fallbackModels,
          label: "memory-hybrid: reinforcement analyze",
          feature: CostFeature.extractReinforcement,
        });
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          analysed = JSON.parse(jsonMatch[0]) as ReinforcementRemediation[];
          analysisCategory = analysed.find((a) => a.category && a.remediationType !== "NO_ACTION")?.category;
        }
      } catch (e) {
        capturePluginError(e as Error, { subsystem: "cli", operation: "runExtractReinforcementForCli:llm-analysis" });
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
                capturePluginError(err as Error, { subsystem: "cli", operation: "reinforcement:positive-rule-dedup" });
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
                ? (c as { text?: string; entity?: string; key?: string; tags?: string[] })
                : { text: String(c) };
            const text = (obj.text ?? "").trim();
            if (!text || factsDb.hasDuplicate(text)) continue;
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
            const entry = factsDb.store({
              text,
              category: isPattern ? "pattern" : "technical",
              importance: CLI_STORE_IMPORTANCE,
              entity: obj.entity ?? null,
              key: typeof obj.key === "string" ? obj.key : null,
              value: text.slice(0, 200),
              source: "reinforcement-analysis",
              tags,
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
          capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractReinforcementForCli" });
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
export async function runGenerateProposalsForCli(
  ctx: HandlerContext,
  opts: { dryRun: boolean; verbose?: boolean },
  api: { resolvePath: (file: string) => string },
): Promise<{ created: number }> {
  const { factsDb, proposalsDb, cfg, openai } = ctx;
  if (!cfg.personaProposals.enabled || !proposalsDb) {
    return { created: 0 };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const scopeFilter = cfg.autoRecall?.scopeFilter ?? undefined;
  const allRelevant = factsDb
    .getAll({ scopeFilter })
    .filter(
      (f) =>
        (f.category === "pattern" || f.category === "rule") &&
        !f.supersededAt &&
        (f.expiresAt === null || f.expiresAt > nowSec),
    );
  if (!scopeFilter && allRelevant.length > 0) {
    ctx.logger.warn?.(
      "memory-hybrid: generate-proposals — autoRecall.scopeFilter is not set; all stored facts are included regardless of which agent or user created them. Set autoRecall.scopeFilter (e.g. agentId/userId) to restrict proposals to a specific user/agent and avoid cross-user contamination.",
    );
  }
  const patterns = allRelevant.filter((f) => f.category === "pattern");
  const rules = allRelevant.filter((f) => f.category === "rule");
  const metaPatterns = patterns.filter((f) => f.tags?.includes("meta"));

  let personaStateBlock = "";
  if (ctx.personaStateStore) {
    const personaStateEntries = new Map(
      ctx.personaStateStore.listRecent(12).map((entry) => [entry.stateKey, entry] as const),
    );

    if (ctx.identityReflectionStore) {
      if (cfg.identityReflection.enabled) {
        const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "default");
        await runIdentityReflection(
          factsDb,
          ctx.identityReflectionStore,
          openai,
          cfg.identityReflection,
          {
            dryRun: opts.dryRun,
            model: cfg.identityReflection.model ?? defaultModel,
            fallbackModels,
            verbose: opts.verbose,
            scopeFilter,
          },
          {
            info: (msg) => ctx.logger.info?.(msg),
            warn: (msg) => ctx.logger.warn?.(msg),
          },
        );
      }

      if (cfg.identityPromotion.enabled) {
        const promotion = promotePersonaStateFromReflections(
          ctx.identityReflectionStore,
          ctx.personaStateStore,
          cfg.identityPromotion,
          { dryRun: opts.dryRun },
        );
        for (const entry of promotion.entries) {
          personaStateEntries.set(entry.stateKey, entry);
        }
        if (opts.verbose && promotion.candidatesFound > 0) {
          ctx.logger.info?.(
            `memory-hybrid: persona-state promotion — ${promotion.promoted} created, ${promotion.updated} updated, ${promotion.unchanged} unchanged`,
          );
        }
      }
    }

    personaStateBlock = buildPersonaStateInsightsBlock(Array.from(personaStateEntries.values()).slice(0, 12));
  }

  const insights: string[] = [];
  if (patterns.length) {
    insights.push(
      `Patterns:\n${patterns
        .slice(0, 30)
        .map((f) => `- ${f.text}`)
        .join("\n")}`,
    );
  }
  if (rules.length) {
    insights.push(
      `Rules:\n${rules
        .slice(0, 30)
        .map((f) => `- ${f.text}`)
        .join("\n")}`,
    );
  }
  if (metaPatterns.length) {
    insights.push(
      `Meta-patterns:\n${metaPatterns
        .slice(0, 10)
        .map((f) => `- ${f.text}`)
        .join("\n")}`,
    );
  }
  if (personaStateBlock) {
    insights.push(`Durable persona state:\n${personaStateBlock}`);
  }
  if (insights.length === 0) {
    if (opts.verbose)
      ctx.logger.info?.("memory-hybrid: generate-proposals — no patterns/rules/meta in memory; skipping.");
    return { created: 0 };
  }
  const insightsBlock = insights.join("\n\n");
  const allowedFiles = cfg.personaProposals.allowedFiles;
  const identityFilesContent: string[] = [];
  for (const file of allowedFiles) {
    try {
      const path = api.resolvePath(file);
      if (existsSync(path)) {
        const content = readFileSync(path, "utf-8");
        identityFilesContent.push(`--- ${file} ---\n${content.slice(0, 8000)}\n`);
      } else {
        identityFilesContent.push(`--- ${file} ---\n(file not found)\n`);
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "cli",
        operation: "runGenerateProposalsForCli:read-file",
        file,
      });
      identityFilesContent.push(`--- ${file} ---\n(error reading file)\n`);
    }
  }
  const identityFilesBlock = identityFilesContent.join("\n");
  const prompt = fillPrompt(loadPrompt("generate-proposals"), {
    allowed_files: allowedFiles.join(", "),
    min_confidence: String(cfg.personaProposals.minConfidence),
    insights: insightsBlock,
    identity_files: identityFilesBlock,
  });
  const cronCfg = getCronModelConfig(cfg);
  const pref = getLLMModelPreference(cronCfg, "heavy");
  const model = pref[0];
  const fallbackModels = pref.length > 1 ? pref.slice(1) : cfg.llm ? [] : (cfg.distill?.fallbackModels ?? []);
  let rawResponse: string;
  try {
    rawResponse = await chatCompleteWithRetry({
      model,
      content: prompt,
      temperature: 0.3,
      maxTokens: 4000,
      openai,
      fallbackModels,
      label: "memory-hybrid: generate-proposals",
      feature: CostFeature.generateProposals,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `memory-hybrid: generate-proposals LLM call failed (model=${model}, fallbacks=${JSON.stringify(fallbackModels)}): ${errMsg}`,
    );
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "cli",
      operation: "runGenerateProposalsForCli:llm",
    });
    return { created: 0 };
  }
  let items: Array<{
    targetFile: string;
    title: string;
    observation: string;
    suggestedChange: string;
    confidence: number;
  }>;
  try {
    const firstBracket = rawResponse.indexOf("[");
    const lastBracket = rawResponse.lastIndexOf("]");
    const trimmed =
      firstBracket !== -1 && lastBracket !== -1 && lastBracket >= firstBracket
        ? rawResponse.substring(firstBracket, lastBracket + 1)
        : rawResponse;
    items = JSON.parse(trimmed);
    if (!Array.isArray(items)) items = [];
  } catch (_err) {
    if (opts.verbose)
      ctx.logger.warn?.(
        `memory-hybrid: generate-proposals — LLM output was not valid JSON: ${rawResponse.slice(0, 200)}`,
      );
    return { created: 0 };
  }
  const weekDays = 7;
  const recentCount = proposalsDb.countRecentProposals(weekDays);
  const limit = cfg.personaProposals.maxProposalsPerWeek;
  const minConf = cfg.personaProposals.minConfidence;
  const evidenceSessions = Array.from(
    { length: Math.max(1, cfg.personaProposals.minSessionEvidence) },
    () => "reflection-pipeline",
  );
  const expiresAt =
    cfg.personaProposals.proposalTTLDays > 0 ? nowSec + cfg.personaProposals.proposalTTLDays * 24 * 3600 : null;
  let created = 0;
  for (const item of items) {
    if (recentCount + created >= limit) break;
    const targetFile = String(item.targetFile ?? "").trim();
    if (!allowedFiles.includes(targetFile as any)) continue;
    const workspace = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
    const snapshot = getFileSnapshot(join(workspace, targetFile));
    let confidence = Number(item.confidence);
    if (!Number.isFinite(confidence)) continue;
    confidence = capProposalConfidence(confidence, targetFile, String(item.suggestedChange ?? ""));
    if (confidence < minConf) {
      ctx.logger.info?.(
        `memory-hybrid: proposal dropped — confidence ${confidence < Number(item.confidence) ? `capped to ${confidence.toFixed(2)} (below minConf ${minConf})` : `below minConf ${minConf}`}: ${String(item.title ?? "").slice(0, 80)} -> ${targetFile}`,
      );
      continue;
    }
    const title = String(item.title ?? "Update from reflection").slice(0, 256);
    const observation = String(item.observation ?? "").slice(0, 2000);
    const suggestedChange = String(item.suggestedChange ?? "").slice(0, 50000);
    if (!suggestedChange.trim()) continue;
    if (opts.dryRun) {
      if (opts.verbose) ctx.logger.info?.(`memory-hybrid: [dry-run] would create proposal: ${title} -> ${targetFile}`);
      created++;
      continue;
    }
    try {
      proposalsDb.create({
        targetFile,
        title,
        observation,
        suggestedChange,
        confidence,
        evidenceSessions,
        expiresAt,
        targetMtimeMs: snapshot?.mtimeMs ?? null,
        targetHash: snapshot?.hash ?? null,
      });
      created++;
      if (opts.verbose) ctx.logger.info?.(`memory-hybrid: proposal created: ${title} -> ${targetFile}`);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "cli",
        operation: "runGenerateProposalsForCli:create",
      });
    }
  }
  return { created };
}

/**
 * Extract facts from daily memory markdown files
 */
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
          factsDb.supersede(classification.targetId, null);
          aliasDb?.deleteByFactId(classification.targetId);
          continue;
        }
        if (classification.action === "UPDATE" && classification.targetId) {
          const oldFact = factsDb.getById(classification.targetId);
          if (oldFact) {
            const newEntry = factsDb.store({
              ...storePayload,
              entity: extracted.entity ?? oldFact.entity,
              key: extracted.key ?? oldFact.key,
              value: extracted.value ?? oldFact.value,
              validFrom: sourceDateSec,
              supersedesId: classification.targetId,
            });
            factsDb.supersede(classification.targetId, newEntry.id);
            aliasDb?.deleteByFactId(classification.targetId);
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
        const entry = factsDb.store(storePayload);
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
          capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractDailyForCli:vector-store-final" });
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
          `  [${category}] ${extracted.entity || "?"} / ${extracted.key || "?"} = ${
            extracted.value || trimmed.slice(0, 60)
          }`,
        );
        continue;
      }
      if (factsDb.hasDuplicate(trimmed)) continue;
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
          capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractDailyForCli:embed" });
        }
        if (vecForStore) {
          let similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vecForStore, 3);
          if (similarFacts.length === 0) {
            similarFacts = factsDb.findSimilarForClassification(trimmed, extracted.entity, extracted.key, 3);
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
          await vectorDb.store({ text: trimmed, vector, importance: BATCH_STORE_IMPORTANCE, category, id: entry.id });
        }
      } catch (err) {
        sink.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
        capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractDailyForCli:vector-store-final" });
      }
      totalStored++;
    }
    await flushPendingExtractClassify();
  }
  await flushPendingExtractClassify();
  return { totalExtracted, totalStored, daysBack, dryRun: opts.dryRun };
}
