/** Reinforcement extraction CLI (`runExtractReinforcementForCli`). Split from cmd-extract.ts. */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ReinforcementContext } from "../backends/facts-db.js";
import {
  getCronModelConfig,
  getDefaultCronModel,
  resolveReflectionModelAndFallbacks,
  resolveReinforcementThinkingMode,
} from "../config.js";
import {
  appendUniqueRemediationsByIncidentIndex,
  attachOrderedItemsToIncidents,
  globalIncidentOffsetForBatch,
  orderBatchItemsByIncidentIndex,
} from "../services/batch-incident-analysis.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "../services/adaptive-maintenance-llm.js";
import { maintenanceMaxOutputTokens } from "../services/chat.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import {
  analyzeReinforcementIncidentBatchWithSplit,
  resolveReinforcementAnalysisBatchSize,
  type ReinforcementRemediationItem,
} from "../services/reinforcement-batch-analyze.js";
import { resolveSelfCorrectionBatchDelayMs } from "../services/self-correction-batch-analyze.js";
import { capturePluginError } from "../services/error-reporter.js";
import { emitPipelinePersonaProposed } from "../services/change-feed-emit.js";
import {
  type AnnotationReasons,
  type ReinforcementAnnotationDiagnostic,
  type ReinforcementAnnotationStatus,
  type ReinforcementExtractResult,
  runReinforcementExtract,
} from "../services/reinforcement-extract.js";
import { preFilterSessions } from "../services/session-pre-filter.js";
import { insertRulesUnderSection, ruleExistsInContent } from "../services/tools-md-section.js";
import { resolveCliWorkspaceRoot } from "../utils/cli-workspace-root.js";
import { cleanupEvictedVector } from "../services/vector-maintenance.js";
import { findSimilarByEmbedding } from "../services/vector-search.js";
import { CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import { getEnv } from "../utils/env-manager.js";
import { getReinforcementSignalRegex } from "../utils/language-keywords.js";
import { redactMaintenancePrivateText } from "../utils/maintenance-privacy.js";
import { parseStructuredItemsAcceptingEmpty } from "../utils/llm-json-array.js";
import { resolveTierPreferenceWithSources } from "../utils/llm-selection.js";
import { resolveExtractSessionFilePaths } from "../services/extract-session-paths.js";
import { getMaxMtime } from "./cmd-extract-sessions.js";
import { buildPreFilterConfig } from "./cmd-install.js";
import { inferTargetFile } from "./cmd-store.js";
import { resolvePipelineProposalTarget } from "./proposals.js";
import { workshopStoresFromHandlerContext } from "../services/unified-proposals.js";
import type { HandlerContext } from "./handlers.js";
import { resolveScanMaintenanceOverrides } from "./maintenance-overrides.js";
import { acquireScanSlot, clearScanLock } from "./shared.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { nowIso } from "../utils/dates.js";
import type { ReinforcementIncident } from "../services/reinforcement-extract.js";
import { MaintenanceJobRun } from "../services/maintenance-job-run/job-run.js";
import {
  finishReinforcementJobRun,
  loadReinforcementBatchResume,
  persistReinforcementBatchState,
  reinforcementRunToJobRunOutcome,
  removeLegacyReinforcementState,
} from "../services/maintenance-job-run/reinforcement-bridge.js";

const REINFORCEMENT_BATCH_STATE_VERSION = 1;

/** Resume state files under `<workspace>/tmp/reinforcement-analysis/`. */
export const REINFORCEMENT_BATCH_STATE_PREFIX = "reinforcement-batches-";

export function resolveReinforcementBatchStateDir(workspaceRoot: string): string {
  return join(workspaceRoot, "tmp", "reinforcement-analysis");
}

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
  incidentIndex?: number;
  sourceIncident?: ReinforcementIncident;
};

type ReinforcementBatchDiagnostics = {
  parseFailures: number;
  fallbacks: number;
  parsedItems: number;
  batchSplits: number;
  truncations: number;
  retries: number;
};

type ReinforcementBatchState = {
  version: number;
  incidentsHash: string;
  batchSize: number;
  totalBatches: number;
  completedBatchIndexes: number[];
  analysed: ReinforcementRemediation[];
  diagnostics: ReinforcementBatchDiagnostics;
  updatedAt: string;
};

function isReinforcementBatchStateFile(name: string): boolean {
  return name.startsWith(REINFORCEMENT_BATCH_STATE_PREFIX) && name.endsWith(".json");
}

function stableReinforcementHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function buildReinforcementRunFingerprint(
  incidents: ReinforcementIncident[],
  model: string,
  batchSize: number,
  dryRun: boolean,
): string {
  return stableReinforcementHash(JSON.stringify({ incidents, model, batchSize, dryRun }));
}

function ensureReinforcementStateDir(workspaceRoot: string): string {
  const dir = resolveReinforcementBatchStateDir(workspaceRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function pruneStaleReinforcementStateFiles(stateDir: string, keepPath: string): void {
  try {
    for (const name of readdirSync(stateDir)) {
      if (!isReinforcementBatchStateFile(name)) continue;
      const fullPath = join(stateDir, name);
      if (fullPath === keepPath) continue;
      rmSync(fullPath, { force: true });
    }
  } catch {
    /* best-effort */
  }
}

function emptyReinforcementDiagnostics(): ReinforcementBatchDiagnostics {
  return {
    parseFailures: 0,
    fallbacks: 0,
    parsedItems: 0,
    batchSplits: 0,
    truncations: 0,
    retries: 0,
  };
}

/** @internal Exported for unit tests. */
export function readReinforcementBatchState(statePath: string): ReinforcementBatchState | null {
  try {
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<ReinforcementBatchState>;
    if (
      parsed.version !== REINFORCEMENT_BATCH_STATE_VERSION ||
      typeof parsed.incidentsHash !== "string" ||
      typeof parsed.batchSize !== "number" ||
      typeof parsed.totalBatches !== "number" ||
      !Array.isArray(parsed.completedBatchIndexes) ||
      !Array.isArray(parsed.analysed)
    ) {
      return null;
    }
    const completed = parsed.completedBatchIndexes
      .filter((n): n is number => Number.isInteger(n) && n >= 0 && n < (parsed.totalBatches ?? 0))
      .sort((a, b) => a - b);
    const diagnostics = parsed.diagnostics ?? emptyReinforcementDiagnostics();
    return {
      version: parsed.version,
      incidentsHash: parsed.incidentsHash,
      batchSize: parsed.batchSize,
      totalBatches: parsed.totalBatches,
      completedBatchIndexes: [...new Set(completed)],
      analysed: parsed.analysed as ReinforcementRemediation[],
      diagnostics: {
        parseFailures: Number.isFinite(diagnostics.parseFailures) ? diagnostics.parseFailures : 0,
        fallbacks: Number.isFinite(diagnostics.fallbacks) ? diagnostics.fallbacks : 0,
        parsedItems: Number.isFinite(diagnostics.parsedItems) ? diagnostics.parsedItems : 0,
        batchSplits: Number.isFinite(diagnostics.batchSplits) ? diagnostics.batchSplits : 0,
        truncations: Number.isFinite(diagnostics.truncations) ? diagnostics.truncations : 0,
        retries: Number.isFinite(diagnostics.retries) ? diagnostics.retries : 0,
      },
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
    };
  } catch {
    return null;
  }
}

function writeReinforcementBatchState(statePath: string, state: ReinforcementBatchState): void {
  atomicWriteFile(statePath, `${JSON.stringify({ ...state, updatedAt: nowIso() }, null, 2)}\n`);
}

function removeReinforcementBatchState(statePath: string): void {
  if (!existsSync(statePath)) return;
  try {
    rmSync(statePath, { force: true });
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runExtractReinforcementForCli:cleanup-state" });
  }
}

function chunkReinforcementIncidents<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));
  return batches;
}

export async function runExtractReinforcementForCli(
  ctx: HandlerContext,
  opts: {
    days?: number;
    verbose?: boolean;
    dryRun?: boolean;
    workspace?: string;
    full?: boolean;
    force?: boolean;
    /** Override JobRun artifact root (tests). */
    jobRunLogRoot?: string;
  },
): Promise<ReinforcementExtractResult> {
  const { bypassScanCooldown, bypassWatermark } = resolveScanMaintenanceOverrides(opts);
  const { factsDb, vectorDb, embeddings, openai, cfg, proposalsDb, logger } = ctx;
  const SCAN_TYPE = "extract-reinforcement";
  const days = opts.days ?? 3;
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Startup guard + concurrency lock
  if (!bypassScanCooldown && !opts.dryRun) {
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
    if (!bypassWatermark && cursor) {
      filePaths = resolveExtractSessionFilePaths(cfg, days, cursor.lastSessionTs);
      logger.info?.(`memory-hybrid: ${SCAN_TYPE} incremental — ${filePaths.length} new sessions since last run`);
    } else {
      filePaths = resolveExtractSessionFilePaths(cfg, days);
    }
    const workspaceRoot = resolveCliWorkspaceRoot({ workspace: opts.workspace });

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
    let incidentsTruncatedForAnalysis = false;
    let jobRun: MaintenanceJobRun | null = null;
    let analysedCount = 0;
    const reinfCfg = cfg.reinforcement ?? {};
    const scCfg = cfg.selfCorrection;
    const llmEnabled = (reinfCfg.reinforcementLLMAnalysis ?? scCfg?.reinforcementLLMAnalysis) !== false;
    const runLLMAnalysis = llmEnabled && result.incidents.length > 0 && !opts.dryRun;
    let analysisCategory: string | undefined;

    // LLM analysis step — batched with resume under workspace/tmp/reinforcement-analysis/
    if (runLLMAnalysis) {
      const maxPerRun = reinfCfg.maxIncidentsPerRun ?? 100;
      let incidentsForAnalysis = result.incidents;
      if (incidentsForAnalysis.length > maxPerRun) {
        incidentsTruncatedForAnalysis = true;
        logger.warn?.(
          `memory-hybrid: extract-reinforcement truncated=true incidents=${result.incidents.length} cap=${maxPerRun}`,
        );
        incidentsForAnalysis = incidentsForAnalysis.slice(0, maxPerRun);
      }

      let analysed: ReinforcementRemediation[] = [];
      const diagnostics = emptyReinforcementDiagnostics();
      let totalBatches = 0;
      let completedBatches = 0;
      try {
        const analysisTier = "maintenance" as const;
        const tierPrefWithSources = resolveTierPreferenceWithSources(cfg, analysisTier);
        const cronCfg = getCronModelConfig(cfg);
        const tierResolved = resolveReflectionModelAndFallbacks(cfg, analysisTier);
        const model = tierResolved.defaultModel ?? getDefaultCronModel(cronCfg, analysisTier);
        const fallbackModels = [...new Set((tierResolved.fallbackModels ?? []).filter((m) => m !== model))];
        const modelSource =
          tierPrefWithSources.models[0] === model ? (tierPrefWithSources.sources[0] ?? "built-in") : "built-in";
        const batchSize = resolveReinforcementAnalysisBatchSize(model, reinfCfg, scCfg);
        const batchDelayMs = resolveSelfCorrectionBatchDelayMs(scCfg);
        const batches = chunkReinforcementIncidents(incidentsForAnalysis, batchSize);
        totalBatches = batches.length;
        const runFingerprint = buildReinforcementRunFingerprint(incidentsForAnalysis, model, batchSize, false);
        const stateDir = resolveReinforcementBatchStateDir(workspaceRoot);
        const legacyStatePath = join(stateDir, `${REINFORCEMENT_BATCH_STATE_PREFIX}${runFingerprint}.json`);
        ensureReinforcementStateDir(workspaceRoot);
        pruneStaleReinforcementStateFiles(stateDir, legacyStatePath);
        jobRun = MaintenanceJobRun.create({
          command: SCAN_TYPE,
          inputFingerprint: runFingerprint,
          modelPolicy: { model, fallbacks: fallbackModels },
          resumeCommand: "openclaw hybrid-mem extract-reinforcement",
          logRoot: opts.jobRunLogRoot,
        });
        jobRun.startPhase("extract");
        jobRun.endPhase("extract", "completed", `incidents=${incidentsForAnalysis.length}`);
        jobRun.startPhase("analyze");
        const completedBatchIndexes = new Set<number>();
        const resumeState = loadReinforcementBatchResume<ReinforcementRemediation>(
          jobRun,
          legacyStatePath,
          runFingerprint,
          batchSize,
          batches.length,
        );
        if (resumeState) {
          analysed = [...resumeState.analysed];
          Object.assign(diagnostics, resumeState.diagnostics);
          for (const idx of resumeState.completedBatchIndexes) completedBatchIndexes.add(idx);
          completedBatches = completedBatchIndexes.size;
          logger.info?.(
            `memory-hybrid: extract-reinforcement JobRun resume ${jobRun.jobRunId}; completed=${completedBatchIndexes.size}/${batches.length}`,
          );
        } else {
          logger.info?.(
            `memory-hybrid: extract-reinforcement batch mode: ${batches.length} batch(es), size=${batchSize}`,
          );
        }

        const persistBatchState = () => {
          persistReinforcementBatchState(jobRun!, {
            incidentsHash: runFingerprint,
            batchSize,
            totalBatches: batches.length,
            completedBatchIndexes: [...completedBatchIndexes].sort((a, b) => a - b),
            analysed,
            diagnostics: { ...diagnostics },
          });
        };

        const adaptiveEnabled = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
        const reinforcementThinkingMode = resolveReinforcementThinkingMode(ctx.cfg);
        logger.info?.(`memory-hybrid: extract-reinforcement analysis tier = ${analysisTier}`);
        logger.info?.(
          `memory-hybrid: extract-reinforcement analysis starting with model ${model} (source=${modelSource})`,
        );
        logger.info?.(
          `memory-hybrid: extract-reinforcement fallback chain = [${fallbackModels.length > 0 ? fallbackModels.join(", ") : ""}]`,
        );
        logger.info?.(
          `memory-hybrid: extract-reinforcement batch mode: size=${batchSize} delayMs=${batchDelayMs} thinking=${reinforcementThinkingMode}`,
        );

        const attemptAnalysisJsonRepair = async (
          rawContent: string,
        ): Promise<{ items: ReinforcementRemediation[] | null; fallbacks: number }> => {
          const repairPrompt = [
            "Convert the following model output into a valid JSON array.",
            "Return ONLY JSON (no markdown, no prose).",
            "Each item must include incidentIndex (0-based).",
            "If incidents were present but none can be recovered, emit one NO_ACTION object per incident with incidentIndex.",
            "",
            "MODEL_OUTPUT_START",
            rawContent,
            "MODEL_OUTPUT_END",
          ].join("\n");
          const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
            model,
            modelSource,
            content: repairPrompt,
            temperature: 0,
            maxTokens: maintenanceMaxOutputTokens(model),
            openai,
            fallbackModels,
            label: "memory-hybrid: reinforcement analyze-repair",
            feature: CostFeature.extractReinforcement,
            logger,
            adaptiveStatePath:
              ctx.resolvedSqlitePath && ctx.resolvedSqlitePath.length > 0
                ? join(dirname(ctx.resolvedSqlitePath), ".adaptive-llm-limits.json")
                : undefined,
            enabled: adaptiveEnabled,
            thinkingMode: reinforcementThinkingMode,
          });
          const repaired = parseStructuredItemsAcceptingEmpty(detail.content, (item) => {
            if (typeof item !== "object" || item === null) return false;
            return typeof (item as Record<string, unknown>).remediationType === "string";
          });
          return {
            items: repaired === null ? null : (repaired as ReinforcementRemediation[]),
            fallbacks: detail.modelUsed !== model ? 1 : 0,
          };
        };

        const analyzeDeps = {
          model,
          modelSource,
          openai,
          fallbackModels,
          maxTokens: maintenanceMaxOutputTokens(model),
          adaptiveEnabled,
          thinkingMode: reinforcementThinkingMode,
          adaptiveStatePath:
            ctx.resolvedSqlitePath && ctx.resolvedSqlitePath.length > 0
              ? join(dirname(ctx.resolvedSqlitePath), ".adaptive-llm-limits.json")
              : undefined,
          logger,
          attemptAnalysisJsonRepair,
          onTransientRetry: (info: { attempt: number; delayMs: number; error: Error }) => {
            logger.warn?.(
              `memory-hybrid: extract-reinforcement batch attempt ${info.attempt} failed: ${String(info.error).slice(0, 240)}; retrying in ${info.delayMs}ms`,
            );
          },
        };

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
          if (completedBatchIndexes.has(batchIndex)) continue;
          const batch = batches[batchIndex];
          const globalIncidentOffset = globalIncidentOffsetForBatch(batches, batchIndex);
          const batchLabel = `batch ${batchIndex + 1}/${batches.length}`;
          const result = await analyzeReinforcementIncidentBatchWithSplit({ ...analyzeDeps, batchLabel }, batch);

          if (result.items === null) {
            const trimmedRaw = (result.rawContent ?? "").trim();
            const emptyArrayResponse =
              trimmedRaw === "[]" ||
              (() => {
                try {
                  const parsed = JSON.parse(trimmedRaw);
                  return Array.isArray(parsed) && parsed.length === 0;
                } catch {
                  return false;
                }
              })();
            if (emptyArrayResponse) {
              if (batch.length === 0) {
                completedBatchIndexes.add(batchIndex);
                completedBatches = completedBatchIndexes.size;
                persistBatchState();
                if (batchDelayMs > 0 && batchIndex < batches.length - 1) {
                  await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
                }
                continue;
              }
              const synthesized: ReinforcementRemediationItem[] = batch.map((_, localIdx) => ({
                incidentIndex: localIdx,
                remediationType: "NO_ACTION",
                category: "",
                severity: "",
                remediationContent: "",
              }));
              const ordered = orderBatchItemsByIncidentIndex(batch.length, synthesized, logger, globalIncidentOffset);
              if (ordered === null) {
                diagnostics.parseFailures++;
                throw new Error(
                  `Reinforcement analysis: ${batchLabel} empty [] response could not be mapped to incidents.`,
                );
              }
              const attached = attachOrderedItemsToIncidents<ReinforcementIncident, ReinforcementRemediationItem>(
                batch,
                ordered,
                globalIncidentOffset,
              );
              appendUniqueRemediationsByIncidentIndex(analysed, attached);
              completedBatchIndexes.add(batchIndex);
              completedBatches = completedBatchIndexes.size;
              persistBatchState();
              if (batchDelayMs > 0 && batchIndex < batches.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
              }
              continue;
            }
            diagnostics.parseFailures++;
            const excerpt = (result.rawContent ?? "").slice(0, 240);
            const parseError = new Error(
              `Reinforcement analysis: ${batchLabel} LLM response could not be parsed as a JSON array (repair failed). excerpt="${excerpt}"`,
            );
            (parseError as Error & { isParseFailure?: boolean }).isParseFailure = true;
            throw parseError;
          }

          const ordered = orderBatchItemsByIncidentIndex(batch.length, result.items, logger, globalIncidentOffset);
          if (ordered === null) {
            diagnostics.parseFailures++;
            const coverageError = new Error(
              `Reinforcement analysis: ${batchLabel} incomplete (expected ${batch.length} remediation item(s), could not assign one per incident).`,
            );
            (coverageError as Error & { isParseFailure?: boolean }).isParseFailure = true;
            throw coverageError;
          }

          diagnostics.fallbacks += result.diagnostics.fallbacks;
          diagnostics.parseFailures += result.diagnostics.parseFailures;
          diagnostics.batchSplits += result.diagnostics.batchSplits;
          diagnostics.truncations += result.diagnostics.truncations;
          diagnostics.retries += result.diagnostics.retries;

          const attached = attachOrderedItemsToIncidents<ReinforcementIncident, ReinforcementRemediationItem>(
            batch,
            ordered,
            globalIncidentOffset,
          );
          const added = appendUniqueRemediationsByIncidentIndex(analysed, attached);
          diagnostics.parsedItems += added;
          completedBatchIndexes.add(batchIndex);
          completedBatches = completedBatchIndexes.size;
          persistBatchState();

          if (batchDelayMs > 0 && batchIndex < batches.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
          }
        }

        analysedCount = analysed.length;
        if (completedBatchIndexes.size === batches.length) {
          removeLegacyReinforcementState(stateDir, runFingerprint, REINFORCEMENT_BATCH_STATE_PREFIX);
        } else if (completedBatchIndexes.size > 0 && completedBatchIndexes.size < batches.length) {
          result.partialBatchFailure = true;
          logger.warn?.(
            `memory-hybrid: extract-reinforcement partial batch failure: completed=${completedBatchIndexes.size}/${batches.length} analysed=${analysed.length}`,
          );
        }
        if (jobRun) {
          jobRun.endPhase("analyze", result.partialBatchFailure ? "failed" : "completed", `analysed=${analysedCount}`);
        }
        completedBatches = completedBatchIndexes.size;
        if (incidentsForAnalysis.length > 0 && analysed.length === 0) {
          logger.warn?.(
            `memory-hybrid: extract-reinforcement suspect: ${incidentsForAnalysis.length} incident(s) but zero parsed remediations`,
          );
        }
        analysisCategory = analysed.find((a) => a.category && a.remediationType !== "NO_ACTION")?.category;
      } catch (e) {
        llmAnalysisFailed = completedBatches === 0;
        if (
          (e as Error & { isParseFailure?: boolean }).isParseFailure ||
          (completedBatches > 0 && totalBatches > 0 && completedBatches < totalBatches)
        ) {
          result.partialBatchFailure = true;
        }
        if (jobRun) {
          jobRun.endPhase("analyze", "failed", `error=${String(e).slice(0, 100)}`);
        }
        capturePluginError(e as Error, {
          subsystem: "cli",
          operation: "runExtractReinforcementForCli:llm-analysis",
        });
      }

      const toolsPath = join(workspaceRoot, "TOOLS.md");
      const positiveRulesSection =
        reinfCfg.positiveRulesSection ?? scCfg?.positiveRulesSection ?? "Positive Reinforcement Rules";
      const semanticThreshold = scCfg?.semanticDedupThreshold ?? 0.92;
      const semanticDedup = scCfg?.semanticDedup !== false;
      const toProposals = (reinfCfg.reinforcementToProposals ?? scCfg?.reinforcementToProposals) !== false;

      for (const a of analysed) {
        if (a.remediationType === "NO_ACTION") continue;
        try {
          if (a.remediationType === "POSITIVE_RULE") {
            const line =
              typeof a.remediationContent === "string"
                ? a.remediationContent
                : ((a.remediationContent as { text?: string })?.text ?? "");
            const trimmedRule = line.trim();
            if (!trimmedRule) continue;

            if (existsSync(toolsPath)) {
              const currentTools = readFileSync(toolsPath, "utf-8");
              if (ruleExistsInContent(currentTools, trimmedRule)) continue;
            }

            let ruleVec: number[] | null = null;
            if (semanticDedup) {
              try {
                ruleVec = await embeddings.embed(trimmedRule);
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
              }
            }

            insertRulesUnderSection(toolsPath, positiveRulesSection, [trimmedRule]);

            if (ruleVec) {
              try {
                await vectorDb.store({
                  text: trimmedRule,
                  vector: ruleVec,
                  importance: CLI_STORE_IMPORTANCE,
                  category: "technical",
                  id: `positive-rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                });
              } catch (err) {
                capturePluginError(err as Error, {
                  subsystem: "cli",
                  operation: "reinforcement:positive-rule-vector-store",
                });
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
              suppressVectorFallbackWarning: true,
            });
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
              const resolved = resolvePipelineProposalTarget({
                targetFile,
                suggestedChange,
                allowedFiles: cfg.personaProposals.allowedFiles,
                workspaceRoot,
                confidence: 0.7,
                proposalTTLDays: cfg.personaProposals.proposalTTLDays,
                minConfidence: cfg.personaProposals.minConfidence,
                proposalsDb,
                workshopStores: workshopStoresFromHandlerContext(ctx),
              });
              if (!resolved) continue;
              const created = proposalsDb.create({
                targetFile: resolved.targetFile,
                title: `Reinforcement: ${a.category}`,
                observation: "Positive signal from reinforcement analysis",
                suggestedChange: suggestedChange.trim(),
                confidence: resolved.confidence,
                evidenceSessions: result.incidents
                  .map((i) => i.sessionFile)
                  .filter((v, idx, arr) => arr.indexOf(v) === idx),
                expiresAt: resolved.expiresAt,
                targetMtimeMs: resolved.targetMtimeMs,
                targetHash: resolved.targetHash,
              });
              emitPipelinePersonaProposed(ctx.changeFeed, cfg, created);
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
          let reinforcedViaSimilarity = false;
          let praiseStored = false;
          // Embedding-similarity fallback when agent did not call memory_recall (#1802).
          try {
            const contextText = [incident.agentBehavior, incident.precedingUserMessage, incident.userMessage]
              .filter(Boolean)
              .join(" ")
              .slice(0, 500);
            if (contextText.trim().length >= 20) {
              const vector = await embeddings.embed(contextText);
              const similar = await findSimilarByEmbedding(vectorDb, factsDb, vector, 1, 0.55);
              if (similar.length > 0) {
                const entry = similar[0];
                const nowSec = Math.floor(Date.now() / 1000);
                if (entry.expiresAt == null || entry.expiresAt > nowSec) {
                  const context: ReinforcementContext = {
                    querySnippet: incident.precedingUserMessage.slice(0, 200) || incident.userMessage.slice(0, 200),
                    topic: analysisCategory,
                    toolSequence: incident.toolCallSequence.length > 0 ? incident.toolCallSequence : undefined,
                    sessionFile: incident.sessionFile,
                  };
                  const diversityWeight = cfg.reinforcement?.diversityWeight ?? 1.0;
                  const baseBoost = cfg.reinforcement?.boostAmount ?? 1.0;
                  const diversityScore = factsDb.calculateDiversityScore(entry.id);
                  const effectiveBoost = baseBoost * (1 - diversityWeight + diversityWeight * diversityScore);
                  const ok = factsDb.reinforceFact(entry.id, incident.userMessage, context, {
                    trackContext,
                    maxEventsPerFact,
                    boostAmount: effectiveBoost,
                  });
                  if (ok) {
                    reinforcedViaSimilarity = true;
                    annotated++;
                    annotationReasons.reinforced++;
                  }
                }
              }
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "runExtractReinforcementForCli:similarity-fallback",
            });
          }

          // Store standalone praise signal when similarity fallback found nothing.
          if (!reinforcedViaSimilarity && incident.confidence >= 0.55) {
            try {
              const praiseText = redactMaintenancePrivateText(
                `[Reinforcement praise] User: "${incident.userMessage.slice(0, 180)}" — praised behavior: ${incident.agentBehavior.slice(0, 180)}`,
              );
              if (!factsDb.hasDuplicate(praiseText, "reinforcement-praise")) {
                const storeResult = factsDb.storeWithResult({
                  text: praiseText,
                  category: "preference",
                  importance: Math.min(0.85, 0.5 + incident.confidence * 0.3),
                  entity: null,
                  key: "reinforcement_praise",
                  value: praiseText.slice(0, 200),
                  source: "reinforcement-praise",
                  confidence: incident.confidence,
                  tags: ["reinforcement", "praise", "no-recall-ids"],
                  decayClass: "normal",
                  suppressVectorFallbackWarning: true,
                });
                if (!storeResult.skipped && (storeResult.newlyStored || storeResult.embeddingStale)) {
                  praiseStored = true;
                  annotated++;
                  annotationReasons.reinforced++;
                  await cleanupEvictedVector({
                    vectorDb: ctx.vectorDb,
                    evictedFactId: storeResult.evictedFactId,
                    logger: ctx.logger,
                    context: "extract-reinforcement-praise",
                  });
                }
              }
            } catch (err) {
              annotationReasons.errors++;
              capturePluginError(err as Error, {
                subsystem: "cli",
                operation: "runExtractReinforcementForCli:praise-signal",
              });
            }
          }
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
          if (!reinforcedViaSimilarity && !praiseStored) {
            annotationReasons.noRecalledIds++;
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
      if (llmAnalysisFailed) {
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
      } else if (annotationStatus === "failed_annotation") {
        annotationDiagnostic = {
          kind: "mixed_failure",
          summary: `Mixed failure: ${annotationReasons.noRecalledIds} incident(s) had no recalled IDs, ${annotationReasons.recalledIdsNoMatch} had stale IDs.`,
          recommendedActions: [
            "Address both missing recall metadata and stale ID issues.",
            "Inspect sessions without recalled IDs for memory_recall usage gaps.",
            "Audit stale/superseded IDs in the remaining sessions.",
          ],
        };
      }
    }

    // Attach annotation results to the returned value
    result.annotated = annotated;
    result.annotationReasons = annotationReasons;
    if (annotationStatus !== undefined) result.annotationStatus = annotationStatus;
    if (annotationDiagnostic) result.annotationDiagnostic = annotationDiagnostic;

    if (!opts.dryRun && !llmAnalysisFailed && !result.partialBatchFailure && !incidentsTruncatedForAnalysis) {
      const lastSessionTs = getMaxMtime(filePaths);
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, result.sessionsScanned);
    }

    const semanticOutcome = opts.dryRun
      ? result.incidents.length === 0
        ? "empty"
        : "skipped"
      : reinforcementRunToJobRunOutcome({
          partialBatchFailure: result.partialBatchFailure,
          llmAnalysisFailed,
          incidentsCount: result.incidents.length,
          analysedCount,
          annotated: result.annotated,
        });
    const allBatchesDone = !result.partialBatchFailure && !llmAnalysisFailed;
    result.jobRunId = finishReinforcementJobRun(jobRun, semanticOutcome, {
      clearCheckpoint: allBatchesDone && semanticOutcome !== "failed_semantic_empty",
    });
    result.semanticOutcome = semanticOutcome;

    return result;
  } finally {
    if (!bypassScanCooldown && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}
