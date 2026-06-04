import { getEnv } from "../utils/env-manager.js";
/**
 * Self-Correction CLI Handlers
 *
 * Implements the self-correction commands:
 *   - self-correction extract — scan recent sessions for correction incidents
 *   - self-correction run     — analyse incidents with LLM and apply remediations
 *
 * The two constants below are self-correction-specific and live here rather than
 * in the shared constants module because they are only consumed by these handlers.
 */

import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getCronModelConfig, getDefaultCronModel, resolveReflectionModelAndFallbacks } from "../config.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "../services/adaptive-maintenance-llm.js";
import { distillMaxOutputTokens } from "../services/chat.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import { capturePluginError } from "../services/error-reporter.js";
import { type CorrectionIncident, runSelfCorrectionExtract } from "../services/self-correction-extract.js";
import { preFilterSessions } from "../services/session-pre-filter.js";
import { insertRulesUnderSection } from "../services/tools-md-section.js";
import { cleanupEvictedVector } from "../services/vector-maintenance.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import { getCorrectionSignalRegex } from "../utils/language-keywords.js";
import { stripThinkingWrapperBlocks, tryParseFirstJsonArray } from "../utils/llm-json-array.js";
import { resolveTierPreferenceWithSources } from "../utils/llm-selection.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { estimateTokens } from "../utils/text.js";
import { gatherSessionFiles } from "./cmd-distill.js";
import { buildPreFilterConfig } from "./cmd-install.js";
import { inferTargetFile } from "./cmd-store.js";
import type { HandlerContext } from "./handlers.js";
import { resolveScanMaintenanceOverrides } from "./maintenance-overrides.js";
import { acquireScanSlot, clearScanLock } from "./shared.js";
import type { SelfCorrectionExtractResult, SelfCorrectionRunResult } from "./types.js";


type SelfCorrectionRemediation = {
  category: string;
  severity: string;
  remediationType: string;
  remediationContent: string | { text?: string; entity?: string; key?: string; tags?: string[] };
  repeated?: boolean;
};

type SelfCorrectionBatchState = {
  version: number;
  incidentsHash: string;
  batchSize: number;
  totalBatches: number;
  completedBatchIndexes: number[];
  analysed: SelfCorrectionRemediation[];
  diagnostics: SelfCorrectionRunDiagnostics;
  updatedAt: string;
};

type SelfCorrectionRunDiagnostics = {
  retries: number;
  fallbacks: number;
  parseFailures: number;
  unparseableFailures: number;
  parsedItems: number;
};

const SELF_CORRECTION_BATCH_SIZE = 25;
const SELF_CORRECTION_BATCH_STATE_VERSION = 1;

function stableSelfCorrectionHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function emptySelfCorrectionDiagnostics(): SelfCorrectionRunDiagnostics {
  return { retries: 0, fallbacks: 0, parseFailures: 0, unparseableFailures: 0, parsedItems: 0 };
}

function readSelfCorrectionBatchState(statePath: string): SelfCorrectionBatchState | null {
  try {
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<SelfCorrectionBatchState>;
    if (
      parsed.version !== SELF_CORRECTION_BATCH_STATE_VERSION ||
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
    const diagnostics = parsed.diagnostics ?? emptySelfCorrectionDiagnostics();
    return {
      version: parsed.version,
      incidentsHash: parsed.incidentsHash,
      batchSize: parsed.batchSize,
      totalBatches: parsed.totalBatches,
      completedBatchIndexes: [...new Set(completed)],
      analysed: parsed.analysed as SelfCorrectionRemediation[],
      diagnostics: {
        retries: Number.isFinite(diagnostics.retries) ? diagnostics.retries : 0,
        fallbacks: Number.isFinite(diagnostics.fallbacks) ? diagnostics.fallbacks : 0,
        parseFailures: Number.isFinite(diagnostics.parseFailures) ? diagnostics.parseFailures : 0,
        unparseableFailures: Number.isFinite(diagnostics.unparseableFailures) ? diagnostics.unparseableFailures : 0,
        parsedItems: Number.isFinite(diagnostics.parsedItems) ? diagnostics.parsedItems : 0,
      },
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function writeSelfCorrectionBatchState(statePath: string, state: SelfCorrectionBatchState): void {
  atomicWriteFile(statePath, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

function chunkSelfCorrectionIncidents<T>(items: T[], batchSize = SELF_CORRECTION_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));
  return batches;
}

function isTransientSelfCorrectionLlmError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /request was aborted|operation was aborted|llm request timeout|timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|connection error/i.test(
    msg,
  );
}

async function sleepSelfCorrectionBackoff(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeSelfCorrectionDiagnostics(
  target: SelfCorrectionRunDiagnostics,
  source: Partial<SelfCorrectionRunDiagnostics>,
): void {
  target.retries += source.retries ?? 0;
  target.fallbacks += source.fallbacks ?? 0;
  target.parseFailures += source.parseFailures ?? 0;
  target.unparseableFailures += source.unparseableFailures ?? 0;
  target.parsedItems += source.parsedItems ?? 0;
}

// ---------------------------------------------------------------------------
// Module-level constants (self-correction-specific)
// ---------------------------------------------------------------------------

/** Maximum number of remediation items to auto-apply per run. */
const SELF_CORRECTION_CAP = 5;

/** Default self-correction configuration values. */
const DEFAULT_SELF_CORRECTION = {
  semanticDedup: true,
  semanticDedupThreshold: 0.92,
  toolsSection: "Self-correction rules",
  applyToolsByDefault: true,
  autoRewriteTools: false,
  analyzeViaSpawn: false,
  spawnThreshold: 15,
  spawnModel: "",
} as const;

function sanitizeLlmResponseExcerpt(content: string): string {
  return content
    .trim()
    .slice(0, 200)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b(?:sk|gh[pousr]|xox[baprs])-[A-Za-z0-9_=-]{8,}\b/g, "[redacted-token]")
    .replace(/\b(api[_-]?key|password|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Self-correction LLM response parser
// ---------------------------------------------------------------------------

/**
 * Parse the JSON array of remediation items from a self-correction LLM response.
 *
 * The model is instructed to return a bare JSON array, but in practice it may:
 *   - wrap the array in a markdown code fence (```json ... ```)
 *   - add prose before or after the array
 *   - emit thinking/reasoning tokens before the JSON (e.g. MiniMax M2.7-highspeed, #1718)
 *   - emit placeholder tokens instead of JSON
 *   - return invalid/truncated JSON
 *
 * This function handles all of those cases robustly by first stripping thinking
 * wrapper blocks, then scanning balanced `[...]` spans and only accepting arrays
 * that match expected remediation object shape.
 * Returns `null` when no valid array can be extracted (callers treat this as
 * `failed_parse` — no remediations are applied and the error is reported).
 *
 * Scenarios and expected behaviour:
 *   - **strict JSON**: `[{"remediationType":"MEMORY_STORE",...}]` → parsed directly
 *   - **fenced JSON**: `` ```json\n[...]\n``` `` → fence stripped, array parsed
 *   - **trailing text**: `[...]\n\nHere is my explanation` → array extracted, text ignored
 *   - **thinking prefix**: `<thinking>...</thinking>\n[...]` → thinking stripped, array parsed
 *   - **invalid JSON**: `[not valid]` / truncated → null returned, caller handles error
 */
export function parseSelfCorrectionLLMResponse(content: string): unknown[] | null {
  let emptyArrayCandidate: unknown[] | null = null;
  const normalized = stripThinkingWrapperBlocks(content);

  const result = tryParseFirstJsonArray(normalized, (parsed) => {
    if (parsed.length === 0) {
      emptyArrayCandidate = parsed;
      return null;
    }
    return isSelfCorrectionRemediationArray(parsed) ? parsed : null;
  });

  return result ?? emptyArrayCandidate;
}

function isSelfCorrectionRemediationArray(items: unknown[]): boolean {
  return items.every((item) => isSelfCorrectionRemediationItem(item));
}

function isSelfCorrectionRemediationItem(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as Record<string, unknown>;
  const remediationType = candidate.remediationType;
  if (typeof remediationType !== "string" || remediationType.trim().length === 0) return false;

  const isNoAction = remediationType.trim().toUpperCase() === "NO_ACTION";
  if ("remediationContent" in candidate) {
    const remediationContent = candidate.remediationContent;
    if (
      !(
        typeof remediationContent === "string" ||
        (typeof remediationContent === "object" && remediationContent !== null)
      )
    ) {
      return false;
    }
  } else if (!isNoAction) {
    return false;
  }

  if ("category" in candidate && typeof candidate.category !== "string") return false;
  if ("severity" in candidate && typeof candidate.severity !== "string") return false;
  if ("repeated" in candidate && typeof candidate.repeated !== "boolean") return false;

  return true;
}

// ---------------------------------------------------------------------------
// self-correction extract
// ---------------------------------------------------------------------------

/**
 * Extract self-correction incidents from sessions.
 */
export function runSelfCorrectionExtractForCli(
  ctx: HandlerContext,
  opts: {
    days?: number;
    outputPath?: string;
    verbose?: boolean;
    /** Pre-filtered session file paths. When provided, skips gatherSessionFiles(). */
    filePaths?: string[];
  },
): SelfCorrectionExtractResult {
  const filePaths =
    opts.filePaths ?? gatherSessionFiles({ days: opts.days ?? 3 }).map((f: { path: string; mtime: number }) => f.path);
  if (filePaths.length === 0) {
    return { incidents: [], sessionsScanned: 0 };
  }
  if (opts.verbose) {
    ctx.logger.info?.(`memory-hybrid: self-correction-extract — scanning ${filePaths.length} session file(s)`);
    const cap = 40;
    for (let i = 0; i < Math.min(filePaths.length, cap); i++) {
      ctx.logger.info?.(`  ${filePaths[i]}`);
    }
    if (filePaths.length > cap) {
      ctx.logger.info?.(`  ... and ${filePaths.length - cap} more`);
    }
  }
  try {
    const result = runSelfCorrectionExtract({
      filePaths,
      correctionRegex: getCorrectionSignalRegex(),
    });
    if (opts.outputPath && result.incidents.length > 0) {
      try {
        const outputJson = JSON.stringify(result.incidents, null, 2);
        // Follow symlinks so shared extract targets are updated, not replaced.
        if (existsSync(opts.outputPath) && lstatSync(opts.outputPath).isSymbolicLink()) {
          writeFileSync(opts.outputPath, outputJson, "utf-8");
        } else {
          atomicWriteFile(opts.outputPath, outputJson);
        }
      } catch (e) {
        capturePluginError(e as Error, { subsystem: "cli", operation: "runSelfCorrectionExtractForCli:write-output" });
      }
    }
    return result;
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionExtractForCli" });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// self-correction run
// ---------------------------------------------------------------------------

/**
 * Run self-correction analysis and remediation.
 */
export async function runSelfCorrectionRunForCli(
  ctx: HandlerContext,
  opts: {
    extractPath?: string;
    incidents?: CorrectionIncident[];
    workspace?: string;
    dryRun?: boolean;
    model?: string;
    approve?: boolean;
    applyTools?: boolean;
    full?: boolean;
    force?: boolean;
    verbose?: boolean;
  },
): Promise<SelfCorrectionRunResult> {
  const { bypassScanCooldown } = resolveScanMaintenanceOverrides(opts);
  const { factsDb, vectorDb, embeddings, openai, cfg, logger, proposalsDb } = ctx;
  const SCAN_TYPE = "self-correction-run";

  // Startup guard + concurrency lock (skip if already ran within 23h and not forced)
  // Only apply when no explicit incidents/extractPath provided (i.e. fresh scan)
  if (!bypassScanCooldown && !opts.dryRun && !opts.incidents && !opts.extractPath) {
    const cursor = factsDb.getScanCursor(SCAN_TYPE);
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip) {
      const isConcurrency = skip.includes("already running");
      return {
        incidentsFound: 0,
        analysed: 0,
        autoFixed: 0,
        proposals: [],
        reportPath: null,
        skipped: true,
        status: isConcurrency ? "skipped_concurrency" : "skipped_cooldown",
      };
    }
  }

  try {
    const workspaceRoot = opts.workspace ?? getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
    const scCfg = cfg.selfCorrection ?? DEFAULT_SELF_CORRECTION;
    const reportDir = join(workspaceRoot, "memory", "reports");
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = join(reportDir, `self-correction-${today}.md`);
    let incidents: CorrectionIncident[];
    if (opts.incidents !== undefined) {
      incidents = opts.incidents;
    } else if (opts.extractPath) {
      try {
        const raw = readFileSync(opts.extractPath, "utf-8");
        incidents = JSON.parse(raw) as CorrectionIncident[];
      } catch (e) {
        capturePluginError(e as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:read-extract" });
        return { incidentsFound: 0, analysed: 0, autoFixed: 0, proposals: [], reportPath: null, error: String(e) };
      }
    } else {
      // Two-tier pre-filter: use local Ollama to triage sessions before extraction (Issue #290).
      let scFilePaths: string[] | undefined;
      const pfCfgSC = buildPreFilterConfig(cfg);
      if (pfCfgSC.enabled) {
        const sessionFiles = gatherSessionFiles({ days: 3 });
        const allPaths = sessionFiles.map((f: { path: string; mtime: number }) => f.path);
        if (allPaths.length > 0) {
          const pfResult = await preFilterSessions(allPaths, pfCfgSC);
          if (!pfResult.ollamaUnavailable) {
            logger.info?.(
              `memory-hybrid: ${SCAN_TYPE} pre-filter: ${pfResult.kept.length}/${allPaths.length} sessions flagged as interesting`,
            );
            scFilePaths = pfResult.kept;
          } else {
            logger.info?.(`memory-hybrid: ${SCAN_TYPE} pre-filter: Ollama unavailable — scanning all sessions`);
            scFilePaths = allPaths; // avoid redundant gatherSessionFiles inside runSelfCorrectionExtractForCli
          }
        }
      }
      const extractResult = runSelfCorrectionExtractForCli(ctx, {
        days: 3,
        filePaths: scFilePaths,
        verbose: opts.verbose,
      });
      incidents = extractResult.incidents;
    }
    if (incidents.length === 0) {
      const emptyReport = `# Self-Correction Analysis (${today})\n\nScanned sessions: 3 days.\nIncidents found: 0.\n`;
      try {
        atomicWriteFile(reportPath, emptyReport);
      } catch (err) {
        capturePluginError(err as Error, {
          subsystem: "cli",
          operation: "runSelfCorrectionRunForCli:write-empty-report",
        });
      }
      if (!opts.dryRun && !opts.incidents && !opts.extractPath) {
        factsDb.updateScanCursor(SCAN_TYPE, 0, 0);
        clearScanLock(SCAN_TYPE);
      }
      return {
        incidentsFound: 0,
        analysed: 0,
        autoFixed: 0,
        proposals: [],
        reportPath,
        status: "success_no_incidents",
      };
    }
    if (opts.verbose) {
      logger.info?.(`memory-hybrid: ${SCAN_TYPE} — ${incidents.length} incident(s); building LLM prompt…`);
    }
    const heavyResolved = resolveReflectionModelAndFallbacks(cfg, "heavy");
    const heavyPrefWithSources = resolveTierPreferenceWithSources(cfg, "heavy");
    const model = opts.model ?? heavyResolved.defaultModel ?? getDefaultCronModel(getCronModelConfig(cfg), "heavy");
    const modelSource = opts.model
      ? "--model"
      : heavyPrefWithSources.models[0] === model
        ? (heavyPrefWithSources.sources[0] ?? "built-in")
        : "built-in";
    const scFallbackCandidates = opts.model
      ? [heavyResolved.defaultModel, ...(heavyResolved.fallbackModels ?? [])]
      : (heavyResolved.fallbackModels ?? []);
    const scFallbackModels = [...new Set(scFallbackCandidates.filter((m) => m !== model))];
    const maxTokens = distillMaxOutputTokens(model);
    let analysed: SelfCorrectionRemediation[] = [];
    const diagnostics = emptySelfCorrectionDiagnostics();
    const batches = chunkSelfCorrectionIncidents(incidents);
    const incidentsHash = stableSelfCorrectionHash(JSON.stringify(incidents));
    const statePath = join(reportDir, `self-correction-run-state-${incidentsHash}.json`);
    const resumeState = readSelfCorrectionBatchState(statePath);
    const completedBatchIndexes = new Set<number>();
    if (
      resumeState &&
      resumeState.incidentsHash === incidentsHash &&
      resumeState.batchSize === SELF_CORRECTION_BATCH_SIZE &&
      resumeState.totalBatches === batches.length
    ) {
      analysed = [...resumeState.analysed];
      mergeSelfCorrectionDiagnostics(diagnostics, resumeState.diagnostics);
      for (const idx of resumeState.completedBatchIndexes) completedBatchIndexes.add(idx);
      if (opts.verbose && completedBatchIndexes.size > 0) {
        logger.info?.(
          `memory-hybrid: ${SCAN_TYPE} resume state ${statePath}: skipping ${completedBatchIndexes.size}/${batches.length} completed batch(es)`,
        );
      }
    }

    const persistBatchState = () => {
      if (opts.dryRun) return;
      writeSelfCorrectionBatchState(statePath, {
        version: SELF_CORRECTION_BATCH_STATE_VERSION,
        incidentsHash,
        batchSize: SELF_CORRECTION_BATCH_SIZE,
        totalBatches: batches.length,
        completedBatchIndexes: [...completedBatchIndexes].sort((a, b) => a - b),
        analysed,
        diagnostics,
        updatedAt: new Date().toISOString(),
      });
    };

    try {
      const attemptAnalysisJsonRepair = async (
        rawContent: string,
      ): Promise<{ items: SelfCorrectionRemediation[] | null; retries: number; fallbacks: number }> => {
        const repairPrompt = [
          "Convert the following model output into a valid JSON array.",
          "Return ONLY JSON (no markdown, no prose).",
          "If no valid remediation items can be recovered, return [].",
          "",
          "MODEL_OUTPUT_START",
          rawContent,
          "MODEL_OUTPUT_END",
        ].join("\n");
        const adaptiveEnabled = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
        const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
          model,
          modelSource,
          content: repairPrompt,
          temperature: 0,
          maxTokens,
          openai,
          fallbackModels: scFallbackModels,
          label: "memory-hybrid: self-correction analyze-repair",
          feature: CostFeature.selfCorrectionAnalyze,
          logger,
          adaptiveStatePath:
            ctx.resolvedSqlitePath && ctx.resolvedSqlitePath.length > 0
              ? join(dirname(ctx.resolvedSqlitePath), ".adaptive-llm-limits.json")
              : undefined,
          enabled: adaptiveEnabled,
        });
        const repaired = parseSelfCorrectionLLMResponse(detail.content);
        return {
          items: repaired === null ? null : (repaired as SelfCorrectionRemediation[]),
          retries: 0,
          fallbacks: detail.modelUsed !== model ? 1 : 0,
        };
      };

      const analyzeBatch = async (
        batchPrompt: string,
        batchIndex: number,
      ): Promise<{ content: string; retries: number; fallbacks: number }> => {
        const adaptiveEnabled = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
        let transientRetries = 0;
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            logger.info?.(
              `memory-hybrid: ${SCAN_TYPE} batch ${batchIndex + 1}/${batches.length} attempt ${attempt} model=${model} inputTokens≈${estimateTokens(
                batchPrompt,
              )} maxTokens=${maxTokens} fallbackChain=[${scFallbackModels.join(", ")}]`,
            );
            const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
              model,
              modelSource,
              content: batchPrompt,
              temperature: 0.2,
              maxTokens,
              openai,
              fallbackModels: scFallbackModels,
              label: "memory-hybrid: self-correction analyze",
              feature: CostFeature.selfCorrectionAnalyze,
              logger,
              adaptiveStatePath:
                ctx.resolvedSqlitePath && ctx.resolvedSqlitePath.length > 0
                  ? join(dirname(ctx.resolvedSqlitePath), ".adaptive-llm-limits.json")
                  : undefined,
              enabled: adaptiveEnabled,
              onRetry: (info) => {
                diagnostics.retries++;
                logger.warn?.(
                  `memory-hybrid: ${SCAN_TYPE} batch ${batchIndex + 1}/${batches.length} transient LLM failure; retry attempt=${info.attempt} after ${info.delayMs}ms without lowering maxTokens. error=${String(
                    info.error,
                  ).slice(0, 240)}`,
                );
              },
            });
            return {
              content: detail.content,
              retries: transientRetries,
              fallbacks: detail.modelUsed !== model ? 1 : 0,
            };
          } catch (err) {
            lastError = err;
            if (!isTransientSelfCorrectionLlmError(err) || attempt >= 3) throw err;
            transientRetries++;
            const delay = 1000 * 2 ** (attempt - 1);
            logger.warn?.(
              `memory-hybrid: ${SCAN_TYPE} batch ${batchIndex + 1}/${batches.length} transient LLM failure; retry ${attempt}/2 after ${delay}ms without lowering maxTokens. error=${String(
                err,
              ).slice(0, 240)}`,
            );
            await sleepSelfCorrectionBackoff(delay);
          }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      };

      const useSpawn = scCfg.analyzeViaSpawn && incidents.length > scCfg.spawnThreshold;
      if (useSpawn) {
        const prompt = fillPrompt(loadPrompt("self-correction-analyze"), {
          incidents_json: JSON.stringify(incidents),
        });
        const { spawnSync } = await import("node:child_process");
        const { tmpdir: osTmp } = await import("node:os");
        const promptPath = join(osTmp(), `self-correction-prompt-${Date.now()}.txt`);
        writeFileSync(promptPath, prompt, "utf-8");
        const spawnModel = scCfg.spawnModel?.trim() || getDefaultCronModel(getCronModelConfig(cfg), "default");
        const r = spawnSync(
          "openclaw",
          [
            "sessions",
            "spawn",
            "--model",
            spawnModel,
            "--message",
            "Analyze the attached incidents and output ONLY a JSON array (no markdown, no code fences). Use the instructions in the attached file.",
            "--attach",
            promptPath,
          ],
          { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
        );
        try {
          if (existsSync(promptPath)) rmSync(promptPath, { force: true });
        } catch (err) {
          capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:cleanup-tmp" });
        }
        const content = (r.stdout ?? "") + (r.stderr ?? "");
        if (r.status !== 0) throw new Error(`sessions spawn exited ${r.status}: ${content.slice(0, 500)}`);
        const parsedRemediations = parseSelfCorrectionLLMResponse(content);
        if (parsedRemediations !== null) {
          analysed = parsedRemediations as SelfCorrectionRemediation[];
          diagnostics.parsedItems += analysed.length;
        } else {
          diagnostics.parseFailures++;
          diagnostics.unparseableFailures++;
          const excerpt = sanitizeLlmResponseExcerpt(content);
          throw Object.assign(
            new Error(`Self-correction analysis: LLM response could not be parsed as a JSON array. excerpt="${excerpt}"`),
            { isParseFailure: true },
          );
        }
      } else {
        logger.info?.("memory-hybrid: self-correction-run model tier = heavy");
        logger.info?.(`memory-hybrid: self-correction-run starting with model ${model} (source=${modelSource})`);
        logger.info?.(
          `memory-hybrid: self-correction-run fallback chain = [${scFallbackModels.length > 0 ? scFallbackModels.join(", ") : ""}]`,
        );

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
          if (completedBatchIndexes.has(batchIndex)) continue;
          const batch = batches[batchIndex];
          const prompt = fillPrompt(loadPrompt("self-correction-analyze"), {
            incidents_json: JSON.stringify(batch),
          });
          logger.info?.(
            `memory-hybrid: ${SCAN_TYPE} batch ${batchIndex + 1}/${batches.length} start incidents=${batch.length}`,
          );
          const detail = await analyzeBatch(prompt, batchIndex);
          diagnostics.retries += detail.retries;
          diagnostics.fallbacks += detail.fallbacks;
          const parsedRemediations = parseSelfCorrectionLLMResponse(detail.content);
          let batchAnalysed: SelfCorrectionRemediation[] | null = null;
          if (parsedRemediations !== null) {
            batchAnalysed = parsedRemediations as SelfCorrectionRemediation[];
          } else if (detail.content.trim().length > 0) {
            diagnostics.parseFailures++;
            const excerpt = sanitizeLlmResponseExcerpt(detail.content);
            logger.warn?.(
              `memory-hybrid: self-correction-run batch ${batchIndex + 1}/${batches.length} initial JSON parse failed; attempting repair pass. rawExcerpt="${excerpt}"`,
            );
            try {
              const repaired = await attemptAnalysisJsonRepair(detail.content);
              diagnostics.retries += repaired.retries;
              diagnostics.fallbacks += repaired.fallbacks;
              batchAnalysed = repaired.items;
            } catch (repairErr) {
              capturePluginError(repairErr as Error, {
                subsystem: "cli",
                operation: "runSelfCorrectionRunForCli:llm-analysis-repair",
              });
            }
          } else {
            batchAnalysed = [];
          }
          if (batchAnalysed === null) {
            diagnostics.unparseableFailures++;
            const excerpt = sanitizeLlmResponseExcerpt(detail.content);
            const parseError = new Error(
              `Self-correction analysis: batch ${batchIndex + 1}/${batches.length} LLM response could not be parsed as a JSON array (repair failed). excerpt="${excerpt}"`,
            );
            (parseError as any).isParseFailure = true;
            throw parseError;
          }
          diagnostics.parsedItems += batchAnalysed.length;
          analysed.push(...batchAnalysed);
          completedBatchIndexes.add(batchIndex);
          logger.info?.(
            `memory-hybrid: ${SCAN_TYPE} batch ${batchIndex + 1}/${batches.length} parsed item count=${batchAnalysed.length} rawExcerpt="${sanitizeLlmResponseExcerpt(
              detail.content,
            )}"`,
          );
          persistBatchState();
        }
      }
      if (opts.verbose && analysed.length > 0) {
        logger.info?.(
          `memory-hybrid: ${SCAN_TYPE} — LLM returned ${analysed.length} remediation item(s) (before cap/filter)`,
        );
      }
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:llm-analysis" });
      const isParseFailure = (e as any).isParseFailure === true;
      return {
        incidentsFound: incidents.length,
        analysed: analysed.length,
        autoFixed: 0,
        proposals: [],
        reportPath: null,
        error: String(e),
        retryCount: diagnostics.retries,
        fallbackCount: diagnostics.fallbacks,
        parseFailures: diagnostics.parseFailures,
        unparseableFailures: diagnostics.unparseableFailures,
        status: isParseFailure ? "failed_parse" : undefined,
      };
    }
    if (incidents.length > 0 && analysed.length === 0) {
      const error = `Self-correction analysis suspect: ${incidents.length} incident(s) found but zero parsed/analysed remediation items.`;
      logger.warn?.(`memory-hybrid: ${SCAN_TYPE} — ${error}`);
      return {
        incidentsFound: incidents.length,
        analysed: 0,
        autoFixed: 0,
        proposals: [],
        reportPath: null,
        error,
        retryCount: diagnostics.retries,
        fallbackCount: diagnostics.fallbacks,
        parseFailures: diagnostics.parseFailures,
        unparseableFailures: diagnostics.unparseableFailures,
        status: "failed_suspect_zero_parsed",
      };
    }
    const proposals: string[] = [];
    const toolsSuggestions: string[] = [];
    let autoFixed = 0;
    let toolsApplied = 0;
    const toApply = analysed
      .filter((a) => a.remediationType !== "NO_ACTION" && !a.repeated)
      .slice(0, SELF_CORRECTION_CAP);
    const toolsPath = join(workspaceRoot, "TOOLS.md");
    const toolsSection = scCfg.toolsSection;
    const semanticThreshold = scCfg.semanticDedupThreshold ?? 0.92;

    for (const a of toApply) {
      if (a.remediationType === "MEMORY_STORE") {
        const c = a.remediationContent;
        const obj =
          typeof c === "object" && c && "text" in c ? c : { text: String(c), entity: "Fact", tags: [] as string[] };
        const text = (obj.text ?? "").trim();
        if (!text || factsDb.hasDuplicate(text, "self-correction")) continue;
        let vector: number[] | null = null;
        if (scCfg.semanticDedup || !opts.dryRun) {
          try {
            vector = await embeddings.embed(text);
            if (scCfg.semanticDedup && (await vectorDb.hasDuplicate(vector, semanticThreshold))) continue;
          } catch (err) {
            logger.warn?.(`memory-hybrid: self-correction embed/semantic dedup failed: ${err}`);
            capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:embed-dedup" });
            continue;
          }
        }
        if (opts.dryRun) continue;
        try {
          const storeResult = factsDb.storeWithResult({
            text,
            category: "technical",
            importance: CLI_STORE_IMPORTANCE,
            entity: obj.entity ?? null,
            key: typeof obj.key === "string" ? obj.key : null,
            value: text.slice(0, 200),
            source: "self-correction",
            tags: Array.isArray(obj.tags) ? obj.tags : [],
          });
          if (storeResult.skipped) {
            continue;
          }
          const entry = storeResult.entry;
          // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
          await cleanupEvictedVector({
            vectorDb: vectorDb,
            evictedFactId: storeResult.evictedFactId,
            logger: logger,
            context: "self-correction",
          });
          if (vector) {
            await vectorDb.store({
              text,
              vector,
              importance: CLI_STORE_IMPORTANCE,
              category: "technical",
              id: entry.id,
            });
            factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
          }
          autoFixed++;
        } catch (err) {
          logger.warn?.(`memory-hybrid: self-correction MEMORY_STORE failed: ${err}`);
          capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:memory-store" });
        }
      } else if (a.remediationType === "TOOLS_RULE") {
        const line =
          typeof a.remediationContent === "string"
            ? a.remediationContent
            : ((a.remediationContent as { text?: string })?.text ?? "");
        if (line.trim()) toolsSuggestions.push(line.trim());
      } else if (a.remediationType === "AGENTS_RULE" || a.remediationType === "SKILL_UPDATE") {
        const line =
          typeof a.remediationContent === "string"
            ? a.remediationContent
            : ((a.remediationContent as { text?: string })?.text ?? "");
        if (line.trim()) {
          proposals.push(`[${a.remediationType}] ${line.trim()}`);
          // Wire AGENTS_RULE into proposals DB (#260) — closes the dead end
          if (
            a.remediationType === "AGENTS_RULE" &&
            proposalsDb &&
            (scCfg as { agentsRuleToProposals?: boolean }).agentsRuleToProposals !== false &&
            !opts.dryRun
          ) {
            try {
              const targetFile = inferTargetFile(line);
              const incidentContext =
                incidents.length > 0
                  ? `Correction incident: "${incidents[0].userMessage.slice(0, 200)}"`
                  : "Self-correction analysis";
              proposalsDb.create({
                targetFile,
                title: `Self-correction: ${a.category ?? "behavior"}`,
                observation: incidentContext,
                suggestedChange: line.trim(),
                confidence: 0.7,
                evidenceSessions: incidents
                  .map((inc) => inc.sessionFile)
                  .filter((v, idx, arr) => arr.indexOf(v) === idx),
              });
            } catch (err) {
              capturePluginError(err as Error, {
                subsystem: "cli",
                operation: "runSelfCorrectionRunForCli:agents-rule-proposal",
              });
            }
          }
        }
      }
    }

    const noApplyTools = opts.applyTools === false;
    const shouldApplyTools = !opts.dryRun && (scCfg.applyToolsByDefault !== false || opts.approve) && !noApplyTools;
    if (toolsSuggestions.length > 0 && !opts.dryRun) {
      if (scCfg.autoRewriteTools && shouldApplyTools && existsSync(toolsPath)) {
        try {
          const currentTools = readFileSync(toolsPath, "utf-8");
          const rewritePrompt = fillPrompt(loadPrompt("self-correction-rewrite-tools"), {
            current_tools: currentTools,
            new_rules: toolsSuggestions.join("\n"),
          });
          logger.info?.(
            `memory-hybrid: self-correction-run rewrite-tools starting with model ${model} (source=${modelSource})`,
          );
          const adaptiveEnabled = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
          const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
            model,
            modelSource,
            content: rewritePrompt,
            temperature: 0.2,
            maxTokens: 16000,
            openai,
            fallbackModels: scFallbackModels,
            label: "memory-hybrid: self-correction rewrite-tools",
            feature: CostFeature.selfCorrectionRewriteTools,
            logger,
            adaptiveStatePath:
              ctx.resolvedSqlitePath && ctx.resolvedSqlitePath.length > 0
                ? join(dirname(ctx.resolvedSqlitePath), ".adaptive-llm-limits.json")
                : undefined,
            enabled: adaptiveEnabled,
          });
          if (detail.modelUsed !== model) {
            logger.info?.(`memory-hybrid: self-correction-run rewrite-tools used fallback model ${detail.modelUsed}`);
          }
          const cleaned = detail.content
            .trim()
            .replace(/^```\w*\n?|```\s*$/g, "")
            .trim();
          if (cleaned.length > 50) {
            // Follow symlinks so shared TOOLS.md targets are updated, not replaced.
            if (existsSync(toolsPath) && lstatSync(toolsPath).isSymbolicLink()) {
              writeFileSync(toolsPath, cleaned, "utf-8");
            } else {
              atomicWriteFile(toolsPath, cleaned);
            }
            toolsApplied = toolsSuggestions.length;
            autoFixed += toolsApplied;
          }
        } catch (err) {
          logger.warn?.(`memory-hybrid: self-correction TOOLS rewrite failed: ${err}`);
          capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:tools-rewrite" });
        }
      } else if (shouldApplyTools && existsSync(toolsPath)) {
        try {
          const { inserted } = insertRulesUnderSection(toolsPath, toolsSection, toolsSuggestions);
          toolsApplied = inserted;
          autoFixed += inserted;
        } catch (err) {
          capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:insert-tools" });
        }
      }
    }

    const reportLines = [
      `# Self-Correction Analysis (${today})`,
      "",
      `Scanned: last 3 days. Incidents found: ${incidents.length}.`,
      `Parsed/analysed items: ${analysed.length}. Auto-fixed: ${autoFixed}. Needs review: ${proposals.length}.`,
      `Retries: ${diagnostics.retries}. Fallbacks: ${diagnostics.fallbacks}. Parse failures: ${diagnostics.parseFailures}. Unparseable failures: ${diagnostics.unparseableFailures}.`,
      "",
      ...(autoFixed > 0 ? ["## Auto-applied", "", `- ${autoFixed} memory store(s) and/or TOOLS.md rule(s).`, ""] : []),
      ...(toolsSuggestions.length > 0 && toolsApplied === 0 && !scCfg.autoRewriteTools
        ? [
            "## Suggested TOOLS.md rules (not applied this run). To apply: config applyToolsByDefault is true by default, or use --approve. To skip applying: --no-apply-tools.",
            "",
            ...toolsSuggestions.map((s) => `- ${s}`),
            "",
          ]
        : []),
      ...(toolsApplied > 0
        ? ["## TOOLS.md updated", "", `- ${toolsApplied} rule(s) inserted under section "${toolsSection}".`, ""]
        : []),
      ...(proposals.length > 0
        ? ["## Proposed (review before applying)", "", ...proposals.map((p) => `- ${p}`), ""]
        : []),
    ];
    try {
      atomicWriteFile(reportPath, reportLines.join("\n"));
    } catch (e) {
      logger.warn?.(`memory-hybrid: could not write report: ${e}`);
      capturePluginError(e as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:write-report" });
    }
    // Record savings: each auto-fixed incident avoided ~2 manual LLM round-trips
    if (autoFixed > 0 && ctx.costTracker && !opts?.dryRun) {
      ctx.costTracker.recordSavings({
        feature: "self-correction",
        action: "auto-fixed incident",
        countAvoided: autoFixed,
        estimatedSavingUsd: autoFixed * 0.002,
        note: `${autoFixed} incident(s) auto-remediated`,
      });
    }

    if (!opts.dryRun && !opts.incidents && !opts.extractPath) {
      factsDb.updateScanCursor(SCAN_TYPE, Date.now(), incidents.length);
    }

    return {
      incidentsFound: incidents.length,
      analysed: analysed.length,
      autoFixed,
      proposals,
      reportPath,
      toolsSuggestions: toolsSuggestions.length > 0 ? toolsSuggestions : undefined,
      toolsApplied: toolsApplied > 0 ? toolsApplied : undefined,
      retryCount: diagnostics.retries,
      fallbackCount: diagnostics.fallbacks,
      parseFailures: diagnostics.parseFailures,
      unparseableFailures: diagnostics.unparseableFailures,
      status: "success_analyzed",
    };
  } finally {
    if (!bypassScanCooldown && !opts.dryRun && !opts.incidents && !opts.extractPath) clearScanLock(SCAN_TYPE);
  }
}
