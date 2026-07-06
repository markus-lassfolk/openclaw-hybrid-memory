/**
 * Distill CLI Handler Functions
 *
 * Contains runDistillWindowForCli, runRecordDistillForCli, and runDistillForCli.
 * Extracted from handlers.ts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { MemoryCategory } from "../config.js";
import {
  describeMaintenanceFallbackPolicy,
  effectiveDistillMainModelTier,
  isValidCategory,
  resolveDistillDefaultModel,
  resolveDistillThinkingMode,
  resolveReflectionModelAndFallbacks,
} from "../config.js";
import {
  ADAPTIVE_MODEL_LIMITS_VERSION,
  type AdaptiveFailureKind,
  adaptiveFailureShrinkRatios,
  getEffectiveModelLimits,
  loadAdaptiveModelLimits,
  recordAdaptiveFailure,
  recordAdaptiveSuccess,
  saveAdaptiveModelLimits,
} from "../services/adaptive-model-limits.js";
import { isStructuredCredentialCandidate, tryParseCredentialForVault } from "../services/auto-capture.js";
import {
  chatCompleteWithRetryDetailed,
  distillBatchTokenLimit,
  distillMaxOutputTokens,
  is403QuotaOrRateLimitLike,
  is429OrWrapped,
  isConnectionErrorLike,
  isContextLengthError,
  parseRetryAfterMs,
  resolveMaintenanceChatTimeoutMs,
} from "../services/chat.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import {
  abortCredentialVaultWriteOnPointerDedupe,
  buildCredentialPointerText,
  ensureCredentialVaultPointer,
  rollbackVaultCredentialWrite,
} from "../services/credential-vault-pointer.js";
import { capturePluginError } from "../services/error-reporter.js";
import type { MaintenanceJobRun } from "../services/maintenance-job-run/job-run.js";
import {
  createLightJobRun,
  finishLightJobRun,
  type LightJobRunParams,
} from "../services/maintenance-job-run/light-job-run-bridge.js";
import { preFilterSessions } from "../services/session-pre-filter.js";
import { cleanupEvictedVector } from "../services/vector-maintenance.js";
import { BATCH_STORE_IMPORTANCE, DISTILL_DEDUP_THRESHOLD } from "../utils/constants.js";
import { formatDateUtc, formatTimestampUtcFromMs, nowIso } from "../utils/dates.js";
import { getEnv } from "../utils/env-manager.js";
import { resolveTierPreferenceWithSources } from "../utils/llm-selection.js";
import { maybeRedactMaintenanceFactText } from "../utils/maintenance-privacy.js";
import {
  capTimeoutByMaintenanceRunDeadline,
  getMaintenanceRunAbortSignal,
  maintenanceRunDeadlineReached,
  runUntilMaintenanceDeadline,
} from "../utils/maintenance-run-deadline.js";
import { loadPrompt } from "../utils/prompt-loader.js";
import { extractTags } from "../utils/tags.js";
import { chunkSessionText, estimateTokens } from "../utils/text.js";
import { getMaxMtime } from "./cmd-extract.js";
import { buildPreFilterConfig, createProgressReporter } from "./cmd-install.js";
import { startDistillProgress } from "./distill-progress.js";
import { extractTextFromSessionJsonl } from "./distill-session-jsonl.js";
import type { HandlerContext } from "./handlers.js";
import { resolveScanMaintenanceOverrides } from "./maintenance-overrides.js";
import { acquireScanSlot, clearScanLock } from "./shared.js";
import type { DistillCliResult, DistillCliSink, DistillWindowResult, RecordDistillResult } from "./types.js";
import { classifyStoreDedupeMode, resolveDistillVectorCandidates } from "./vector-dedupe-helpers.js";

// Constants used only by distill functions
const FULL_DISTILL_MAX_DAYS = 90;
const INCREMENTAL_MIN_DAYS = 3;

export function gatherSessionFiles(opts: {
  all?: boolean;
  days?: number;
  since?: string;
  sinceTimestampMs?: number;
}): Array<{ path: string; mtime: number }> {
  const openclawDir = join(homedir(), ".openclaw");
  const agentsDir = join(openclawDir, "agents");
  if (!existsSync(agentsDir)) return [];
  const cutoffMs =
    opts.sinceTimestampMs !== undefined
      ? opts.sinceTimestampMs
      : opts.since
        ? new Date(opts.since).getTime()
        : Date.now() - (opts.all ? 90 : (opts.days ?? 3)) * 24 * 60 * 60 * 1000;
  const out: Array<{ path: string; mtime: number }> = [];
  try {
    for (const agentName of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentName.isDirectory()) continue;
      const sessionsDir = join(agentsDir, agentName.name, "sessions");
      if (!existsSync(sessionsDir)) continue;
      for (const f of readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith(".jsonl") || f.name.startsWith(".deleted")) continue;
        const fp = join(sessionsDir, f.name);
        try {
          const stat = statSync(fp);
          if (stat.mtimeMs > cutoffMs) out.push({ path: fp, mtime: stat.mtimeMs });
        } catch (err) {
          capturePluginError(err as Error, { subsystem: "cli", operation: "gatherSessionFiles:stat", filePath: fp });
        }
      }
    }
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "gatherSessionFiles" });
  }
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
}

export function runDistillWindowForCli(ctx: HandlerContext, _opts: { json: boolean }): DistillWindowResult {
  const { resolvedSqlitePath } = ctx;
  const memoryDir = dirname(resolvedSqlitePath);
  const distillLastRunPath = join(memoryDir, ".distill_last_run");
  const now = new Date();
  const nowMs = now.getTime();
  const today = formatDateUtc(Math.floor(nowMs / 1000));
  let mode: "full" | "incremental";
  let startDate: string;
  const endDate = today;
  let mtimeDays: number;

  if (!existsSync(distillLastRunPath)) {
    mode = "full";
    const start = new Date(now);
    start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
    startDate = formatDateUtc(Math.floor(start.getTime() / 1000));
    mtimeDays = FULL_DISTILL_MAX_DAYS;
  } else {
    try {
      const line = readFileSync(distillLastRunPath, "utf-8").split("\n")[0]?.trim() || "";
      if (!line) {
        mode = "full";
        const start = new Date(now);
        start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
        startDate = formatDateUtc(Math.floor(start.getTime() / 1000));
        mtimeDays = FULL_DISTILL_MAX_DAYS;
      } else {
        const lastRun = new Date(line);
        if (Number.isNaN(lastRun.getTime())) {
          mode = "full";
          const start = new Date(now);
          start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
          startDate = formatDateUtc(Math.floor(start.getTime() / 1000));
          mtimeDays = FULL_DISTILL_MAX_DAYS;
        } else {
          mode = "incremental";
          const lastRunDate = formatDateUtc(Math.floor(lastRun.getTime() / 1000));
          const threeDaysAgo = new Date(now);
          threeDaysAgo.setDate(threeDaysAgo.getDate() - INCREMENTAL_MIN_DAYS);
          const threeDaysAgoStr = formatDateUtc(Math.floor(threeDaysAgo.getTime() / 1000));
          startDate = lastRunDate < threeDaysAgoStr ? lastRunDate : threeDaysAgoStr;
          const start = new Date(startDate);
          mtimeDays = Math.ceil((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
          if (mtimeDays < 1) mtimeDays = 1;
        }
      }
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runDistillWindowForCli" });
      mode = "full";
      const start = new Date(now);
      start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
      startDate = formatDateUtc(Math.floor(start.getTime() / 1000));
      mtimeDays = FULL_DISTILL_MAX_DAYS;
    }
  }
  return { mode, startDate, endDate, mtimeDays };
}

/**
 * Record distillation run timestamp
 */
export function runRecordDistillForCli(ctx: HandlerContext): RecordDistillResult {
  const { resolvedSqlitePath } = ctx;
  const memoryDir = dirname(resolvedSqlitePath);
  mkdirSync(memoryDir, { recursive: true });
  const path = join(memoryDir, ".distill_last_run");
  const ts = nowIso();
  try {
    writeFileSync(path, `${ts}\n`, "utf-8");
    return { path, timestamp: ts };
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runRecordDistillForCli" });
    throw err;
  }
}

export async function runDistillForCli(
  ctx: HandlerContext,
  opts: {
    dryRun: boolean;
    all?: boolean;
    days?: number;
    since?: string;
    model?: string;
    verbose?: boolean;
    maxSessions?: number;
    maxSessionTokens?: number;
    full?: boolean;
    force?: boolean;
  },
  sink: DistillCliSink,
): Promise<DistillCliResult> {
  const { bypassScanCooldown, bypassWatermark } = resolveScanMaintenanceOverrides(opts);
  const { factsDb, vectorDb, embeddings, openai, cfg, credentialsDb, logger, resolvedSqlitePath } = ctx;
  const SCAN_TYPE = "distill";
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Startup guard + concurrency lock (skip when --all/--since or scan overrides disable watermark)
  const useWatermark = !bypassWatermark && !opts.all && !opts.since;
  const shouldAcquireLock = !bypassScanCooldown && !opts.all && !opts.since;
  if (shouldAcquireLock && !opts.dryRun) {
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip)
      return { sessionsScanned: 0, factsExtracted: 0, stored: 0, dedupSkipped: 0, dryRun: false, skipped: true };
  }

  try {
    const distillFingerprint = `${opts.all ?? ""}:${opts.since ?? ""}:${opts.days ?? 3}:${opts.dryRun}`;
    let jobRun: MaintenanceJobRun | null = null;
    const withDistillJobRun = (result: DistillCliResult, extra?: Partial<LightJobRunParams>): DistillCliResult => {
      if (result.skipped) return result;
      if (!jobRun) jobRun = createLightJobRun("distill", distillFingerprint);
      const finished = finishLightJobRun(jobRun, {
        skipped: result.skipped,
        dryRun: result.dryRun,
        semanticEmpty: result.semanticEmpty ?? extra?.semanticEmpty,
        partialFailure: result.partialFailure ?? extra?.partialFailure,
        inputsProcessed: result.sessionsScanned,
        outputsProduced: result.dryRun ? result.factsExtracted : result.stored,
        ...extra,
      });
      return { ...result, jobRunId: finished.jobRunId, semanticOutcome: finished.semanticOutcome };
    };

    const gatherOpts =
      useWatermark && cursor && cursor.lastSessionTs > 0
        ? { sinceTimestampMs: cursor.lastSessionTs }
        : { all: opts.all, days: opts.days ?? (opts.all ? 90 : 3), since: opts.since };

    if (useWatermark && cursor && cursor.lastSessionTs > 0) {
      logger.info?.(
        `memory-hybrid: distill incremental — sessions since last run (${formatTimestampUtcFromMs(cursor.lastSessionTs)})`,
      );
    }

    const sessionFiles = gatherSessionFiles(gatherOpts);
    const maxSessions = opts.maxSessions ?? 0;
    let filesToProcess = maxSessions > 0 ? sessionFiles.slice(0, maxSessions) : sessionFiles;
    if (filesToProcess.length === 0) {
      sink.log("No session files found under ~/.openclaw/agents/*/sessions/");
      if (shouldAcquireLock && !opts.dryRun) {
        factsDb.updateScanCursor(SCAN_TYPE, 0, 0);
        clearScanLock(SCAN_TYPE);
      }
      return withDistillJobRun({
        sessionsScanned: 0,
        factsExtracted: 0,
        stored: 0,
        dedupSkipped: 0,
        dryRun: opts.dryRun,
      });
    }

    // Two-tier pre-filter: use local Ollama to triage sessions before cloud LLM (Issue #290).
    // allCandidatePaths captures the full candidate set BEFORE pre-filtering so the cursor
    // watermark always advances past skipped sessions, preventing infinite re-processing loops.
    const allCandidatePaths = filesToProcess.map((f) => f.path);
    const pfCfg = buildPreFilterConfig(cfg);
    if (pfCfg.enabled && filesToProcess.length > 0) {
      const pfResult = await preFilterSessions(allCandidatePaths, pfCfg);
      if (!pfResult.ollamaUnavailable) {
        const keptSet = new Set(pfResult.kept);
        const originalCount = filesToProcess.length;
        filesToProcess = filesToProcess.filter((f) => keptSet.has(f.path));
        sink.log(
          `memory-hybrid: distill pre-filter: ${filesToProcess.length}/${originalCount} sessions flagged as interesting (${pfResult.skipped.length} skipped by local model)`,
        );
      } else {
        sink.log("memory-hybrid: distill pre-filter: Ollama unavailable — processing all sessions");
      }
    }

    // CRITICAL FIX (#1205/#1216): Clamp distill main tier to never use "heavy" to prevent
    // silently starting expensive maintenance on GPT-5.5/O3/etc. when llm.heavy[0] is expensive.
    // Operators who want heavy tier for distill must pass --model explicitly; distill.modelTier
    // is now clamped to maintenance/default/nano.
    const configuredDistillTier = cfg.distill?.modelTier ?? "maintenance";
    const distillMainTier = effectiveDistillMainModelTier(configuredDistillTier);
    if (configuredDistillTier === "heavy") {
      logger.warn?.(
        "memory-hybrid: distill.modelTier=heavy is not supported for the main distill pass (clamped to maintenance). Use --model to override for a single run.",
      );
    }
    const tierPrefWithSources = resolveTierPreferenceWithSources(cfg, distillMainTier);
    const tierResolved = resolveReflectionModelAndFallbacks(cfg, distillMainTier);
    // Single shared resolver (config.ts) so this actual routing decision can never disagree with
    // what `config`/`verify` report as the effective model/source again (#2047) — it also refuses to
    // silently hand distill.defaultModel a model from a disabled provider, falling through to the
    // distill.modelTier result instead.
    const distillDefaultResolved = resolveDistillDefaultModel(cfg, distillMainTier);
    if (distillDefaultResolved.skippedDefaultModelReason) {
      logger.warn?.(`memory-hybrid: ${distillDefaultResolved.skippedDefaultModelReason}`);
    }
    const model = opts.model ?? distillDefaultResolved.model;
    const tierSrcIdx = tierPrefWithSources.models.indexOf(model);
    const modelSource = opts.model
      ? "--model"
      : distillDefaultResolved.source === "distill.defaultModel"
        ? "distill.defaultModel"
        : tierSrcIdx >= 0
          ? (tierPrefWithSources.sources[tierSrcIdx] ?? "built-in")
          : "built-in";
    const distillFallbacks = tierResolved.fallbackModels ?? [];
    const configuredDistillFallbacks = cfg.distill?.fallbackModels ?? [];
    const configuredFallbackModel = cfg.llm?.fallbackModel?.trim() || "";
    const fallbackSources = new Map<string, string>();
    for (let i = 0; i < tierPrefWithSources.models.length; i++) {
      const m = tierPrefWithSources.models[i];
      const s = tierPrefWithSources.sources[i];
      if (m && s) fallbackSources.set(m, s);
    }
    if (configuredFallbackModel) fallbackSources.set(configuredFallbackModel, "llm.fallbackModel");
    for (let i = 0; i < configuredDistillFallbacks.length; i++) {
      const m = configuredDistillFallbacks[i]?.trim();
      if (m && !fallbackSources.has(m)) fallbackSources.set(m, `distill.fallbackModels[${i}]`);
    }

    logger.info?.(`memory-hybrid: distill main model tier = ${distillMainTier}`);
    if (distillMainTier === "maintenance") {
      logger.info?.(`memory-hybrid: distill maintenance fallback policy = ${describeMaintenanceFallbackPolicy(cfg)}`);
    }
    const extractionTier = cfg.distill?.extractionModelTier ?? "nano";
    logger.info?.(`memory-hybrid: distill directives/reinforcement extraction tier = ${extractionTier}`);
    logger.info?.(`memory-hybrid: distill starting with model ${model} (source=${modelSource})`);
    logger.info?.(
      `memory-hybrid: distill fallback chain = [${distillFallbacks.length > 0 ? distillFallbacks.join(", ") : ""}]`,
    );

    const adaptiveEnabled = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
    const envAdaptiveState = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL_STATE") ?? "").trim();
    const inferredAdaptiveState =
      typeof resolvedSqlitePath === "string" && resolvedSqlitePath.length > 0
        ? join(dirname(resolvedSqlitePath), ".adaptive-llm-limits.json")
        : "";
    const adaptiveStatePath = envAdaptiveState || inferredAdaptiveState;
    logger.info?.(
      `memory-hybrid: distill adaptive sizing = ${adaptiveEnabled ? "enabled" : "disabled"} (state=${adaptiveStatePath || "(no path — set OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL_STATE or resolved SQLite)"})`,
    );
    const adaptiveState = adaptiveEnabled
      ? adaptiveStatePath
        ? loadAdaptiveModelLimits(adaptiveStatePath)
        : { version: ADAPTIVE_MODEL_LIMITS_VERSION, models: {} }
      : { version: ADAPTIVE_MODEL_LIMITS_VERSION, models: {} };

    type DistillBlock = { text: string; tokens: number };
    const blocks: DistillBlock[] = [];
    const distillPrompt = loadPrompt("distill-sessions");
    const promptPrefix = `${distillPrompt}\n\n`;
    const promptTokens = estimateTokens(promptPrefix);
    const primaryCatalogBatchLimit = distillBatchTokenLimit(model);
    const primaryCatalogMaxOut = distillMaxOutputTokens(model);
    // Chunk using the primary model's catalog limit only; smaller fallbacks are filtered per-batch later.
    const primaryLimits = adaptiveEnabled
      ? getEffectiveModelLimits({
          state: adaptiveState,
          model,
          catalogBatchTokenLimit: primaryCatalogBatchLimit,
          catalogMaxOutputTokens: primaryCatalogMaxOut,
          minBatchTokenLimit: Math.max(2048, promptTokens + 256),
        })
      : {
          batchTokenLimit: primaryCatalogBatchLimit,
          maxOutputTokens: primaryCatalogMaxOut,
          source: "catalog" as const,
        };
    const safeInitialBatchTokenLimit = Math.min(primaryLimits.batchTokenLimit, primaryCatalogBatchLimit);
    const maxSessionTokens = opts.maxSessionTokens ?? Math.max(256, safeInitialBatchTokenLimit - promptTokens - 256);
    // Reading + chunking every candidate session is synchronous CPU/file-I/O work with no LLM calls,
    // so it never previously consulted the maintenance-run deadline; a large enough backlog (e.g. a
    // wide --days catch-up window after an upgrade) could in principle burn a meaningful slice of a
    // tight verification budget here before the batch loop below ever gets a chance to check it (#2041
    // review finding). Bail out with the same actionable-failure shape as a mid-batch deadline stop
    // rather than silently under-reporting how many sessions were actually scanned.
    const { truncatedAt: filesScanTruncatedAt } = await runUntilMaintenanceDeadline(filesToProcess, ({ path: fp }) => {
      try {
        const text = extractTextFromSessionJsonl(fp);
        if (!text.trim()) return;
        const textTokens = Math.ceil(text.length / 4);
        const chunks = chunkSessionText(text, maxSessionTokens);
        if (chunks.length > 1) {
          sink.log(
            `memory-hybrid: distill: session too large (${textTokens} tokens), splitting into ${chunks.length} chunks`,
          );
        }

        // Safety check: ensure chunks don't exceed model catalog input limit (prompt + block)
        const validChunks = chunks.filter((chunk, idx) => {
          const chunkTokens = estimateTokens(chunk);
          if (promptTokens + chunkTokens > primaryCatalogBatchLimit) {
            sink.warn(
              `memory-hybrid: distill: chunk ${idx + 1} too large for primary model (${promptTokens + chunkTokens} tokens incl prompt), skipping`,
            );
            return false;
          }
          return true;
        });

        for (let c = 0; c < validChunks.length; c++) {
          const header =
            validChunks.length === 1
              ? `\n--- SESSION: ${basename(fp)} ---\n\n`
              : `\n--- SESSION: ${basename(fp)} (chunk ${c + 1}/${validChunks.length}) ---\n\n`;
          const block = header + validChunks[c];
          blocks.push({ text: block, tokens: estimateTokens(block) });
        }
      } catch (err) {
        capturePluginError(err as Error, {
          subsystem: "cli",
          operation: "runDistillForCli:extract-text",
          filePath: fp,
        });
      }
    });
    if (filesScanTruncatedAt >= 0) {
      sink.warn(
        "memory-hybrid: distill: maintenance run deadline reached while scanning sessions; " +
          `stopping at ${filesScanTruncatedAt}/${filesToProcess.length}`,
      );
    }

    const allFacts: Array<{
      category: string;
      text: string;
      entity?: string;
      key?: string;
      value?: string;
      source_date?: string;
      tags?: string[];
    }> = [];
    const progress = createProgressReporter(sink, Math.max(1, blocks.length), "Distilling session chunks");
    let processedBlocks = 0;
    let batchNum = 0;
    let cursorBlock = 0;
    let shrinkBudget = 8;
    let truncatedBatches = 0;
    // Once the primary model times out/connection-errors once this run, every subsequent batch skips
    // straight to the fallback chain instead of re-paying the primary's full retry+timeout cost first
    // (#2043) — a stalled primary otherwise burns ~90s/batch on a call that's already shown it won't
    // succeed, leaving the fallback too little of the deadline to ever complete a single block.
    let primaryUnavailableThisRun = false;
    let nonAdaptiveBatchFactor = 1;
    let nonAdaptiveOutFactor = 1;
    const minBatchForModel = Math.max(2048, promptTokens + 256);

    const effectiveLimitsForModel = (m: string) => {
      const catalogBatchTokenLimit = distillBatchTokenLimit(m);
      const catalogMaxOutputTokens = distillMaxOutputTokens(m);
      if (!adaptiveEnabled) {
        return {
          batchTokenLimit: Math.max(minBatchForModel, Math.floor(catalogBatchTokenLimit * nonAdaptiveBatchFactor)),
          maxOutputTokens: Math.max(128, Math.floor(catalogMaxOutputTokens * nonAdaptiveOutFactor)),
          source: "catalog" as const,
        };
      }
      return getEffectiveModelLimits({
        state: adaptiveState,
        model: m,
        catalogBatchTokenLimit,
        catalogMaxOutputTokens,
        minBatchTokenLimit: minBatchForModel,
        minMaxOutputTokens: Math.max(2048, Math.floor(catalogMaxOutputTokens * 0.25)),
      });
    };

    const persistAdaptiveLimitsToDisk = () => {
      if (!adaptiveStatePath) return;
      try {
        saveAdaptiveModelLimits(adaptiveStatePath, adaptiveState);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "cli",
          operation: "runDistillForCli:save-adaptive-limits",
        });
      }
    };

    const shrinkForRetry = (kind: AdaptiveFailureKind, failureModel: string) => {
      if (adaptiveEnabled && !opts.dryRun && adaptiveStatePath) {
        const flimits = effectiveLimitsForModel(failureModel);
        recordAdaptiveFailure({
          state: adaptiveState,
          model: failureModel,
          kind,
          catalogBatchTokenLimit: distillBatchTokenLimit(failureModel),
          catalogMaxOutputTokens: distillMaxOutputTokens(failureModel),
          usedBatchTokenLimit: flimits.batchTokenLimit,
          usedMaxOutputTokens: flimits.maxOutputTokens,
        });
        persistAdaptiveLimitsToDisk();
      }
      if (!adaptiveEnabled) {
        const { batch: bf, out: of } = adaptiveFailureShrinkRatios(kind);
        nonAdaptiveBatchFactor *= bf;
        nonAdaptiveOutFactor *= of;
      }
    };

    const buildBatch = (startIdx: number, batchTokenLimit: number): { text: string; count: number; tokens: number } => {
      let text = "";
      let tokens = promptTokens;
      let count = 0;
      for (let i = startIdx; i < blocks.length; i++) {
        const b = blocks[i];
        const sep = text ? "\n" : "";
        const nextTokens = tokens + b.tokens;
        if (count > 0 && nextTokens > batchTokenLimit) break;
        if (count === 0 && nextTokens > batchTokenLimit) break;
        text += `${sep}${b.text}`;
        tokens = nextTokens;
        count++;
      }
      return { text, count, tokens };
    };

    let batchFailures = 0;
    // batchFailures also counts deadline stops (below) so cursor-advancement stays conservative — a
    // truncated run must not skip unprocessed sessions. hardBatchFailures counts only genuine
    // implementation/model errors, so the step's semantic outcome can distinguish "ran out of time
    // with real progress" (monitoring, non-blocking) from an actual failure (partial, blocking) (#2043).
    let hardBatchFailures = 0;
    let deadlineTruncated = false;
    // Preserve the first concrete batch failure cause so maintenance surfaces the real reason
    // (model/error kind/message) instead of only `semantic=partial` (#2024).
    let batchFailureReason: string | undefined;
    let lengthRetriesAtCursor = 0;
    const maxLengthRetriesPerCursor = 8;

    if (filesScanTruncatedAt >= 0) {
      batchFailures++;
      deadlineTruncated = true;
      batchFailureReason ??= `session scan aborted: maintenance run deadline reached at ${filesScanTruncatedAt}/${filesToProcess.length} sessions read`;
    }

    // Operator progress/heartbeat (#2029): emit a start marker + periodic block-count heartbeat so a
    // long LLM-bound batch is distinguishable from a hung run. Only counts/status are logged.
    const distillProgress = startDistillProgress({
      verbose: !!opts.verbose,
      logger,
      sessions: filesToProcess.length,
      totalBlocks: blocks.length,
      getState: () => ({ batch: batchNum, processedBlocks, cursorBlock }),
    });

    // filesScanTruncatedAt < 0 guard: the deadline can only move further into the past, never later,
    // so if the scan phase above already recorded a deadline-truncation failure, this loop's own
    // check on its first iteration would always also be true — re-entering would just double-count
    // batchFailures and log a second, spurious "stopping batch loop" line for a batch that never ran.
    while (filesScanTruncatedAt < 0 && cursorBlock < blocks.length) {
      if (maintenanceRunDeadlineReached()) {
        sink.warn("memory-hybrid: distill: maintenance run deadline reached; stopping batch loop");
        batchFailures++;
        deadlineTruncated = true;
        batchFailureReason ??= `batch ${batchNum + 1} aborted: maintenance run deadline reached before completion`;
        break;
      }
      batchNum++;
      const limits = effectiveLimitsForModel(model);
      const batch = buildBatch(cursorBlock, limits.batchTokenLimit);
      if (batch.count <= 0) {
        sink.warn(
          `memory-hybrid: distill: could not fit next block into batchTokenLimit=${limits.batchTokenLimit}; skipping one block`,
        );
        cursorBlock++;
        processedBlocks++;
        progress.update(processedBlocks);
        continue;
      }

      const userContent = `${promptPrefix}${batch.text}`;
      const inputTokens = estimateTokens(userContent);
      const compatibleFallbacks: string[] = [];
      const skippedFallbacks: string[] = [];
      for (const fb of distillFallbacks) {
        if (inputTokens <= distillBatchTokenLimit(fb)) compatibleFallbacks.push(fb);
        else skippedFallbacks.push(fb);
      }
      if (skippedFallbacks.length > 0) {
        logger.info?.(
          `memory-hybrid: distill batch ${batchNum} — skipping context-incompatible fallbacks: ${skippedFallbacks.join(", ")}`,
        );
      }

      logger.info?.(`memory-hybrid: distill batch ${batchNum} starting with model ${model} (source=${modelSource})`);
      let callModel = model;
      let callFallbacks = compatibleFallbacks;
      const primaryInputLimit = distillBatchTokenLimit(model);
      if (inputTokens > primaryInputLimit) {
        if (callFallbacks.length === 0) {
          sink.warn(
            `memory-hybrid: distill batch ${batchNum} input (~${inputTokens} tokens) exceeds primary limit (${primaryInputLimit}) with no compatible fallbacks`,
          );
          batchFailures++;
          hardBatchFailures++;
          batchFailureReason ??= `batch ${batchNum} input (~${inputTokens} tokens) exceeds primary model ${model} limit (${primaryInputLimit}) and all fallbacks were context-incompatible${skippedFallbacks.length > 0 ? ` (skipped: ${skippedFallbacks.join(", ")})` : ""}`;
          break;
        }
        callModel = callFallbacks[0];
        callFallbacks = callFallbacks.slice(1);
        logger.warn?.(
          `memory-hybrid: distill batch ${batchNum} primary ${model} cannot fit ~${inputTokens} tokens (limit ${primaryInputLimit}); using ${callModel} first`,
        );
      } else if (primaryUnavailableThisRun && callFallbacks.length > 0) {
        callModel = callFallbacks[0];
        callFallbacks = callFallbacks.slice(1);
        logger.info?.(
          `memory-hybrid: distill batch ${batchNum} skipping primary ${model} (timed out earlier this run); using ${callModel} first`,
        );
      }
      const usedPrimaryThisAttempt = callModel === model;
      try {
        const detail = await chatCompleteWithRetryDetailed({
          model: callModel,
          content: userContent,
          temperature: 0.2,
          maxTokens: limits.maxOutputTokens,
          openai,
          fallbackModels: callFallbacks,
          label: `memory-hybrid: distill batch ${batchNum}`,
          feature: CostFeature.distillCli,
          thinkingMode: resolveDistillThinkingMode(cfg),
          timeoutMsPerModel: (m) =>
            capTimeoutByMaintenanceRunDeadline(resolveMaintenanceChatTimeoutMs(m, resolveDistillThinkingMode(cfg))),
          signal: getMaintenanceRunAbortSignal(),
        });
        const outputTruncated = detail.finishReason?.toLowerCase() === "length";
        if (outputTruncated) {
          truncatedBatches++;
          logger.warn?.(
            `memory-hybrid: distill batch ${batchNum} output truncated (finish=length); extracted facts may be incomplete`,
          );
          if (shrinkBudget > 0 && !opts.dryRun) {
            shrinkBudget--;
            shrinkForRetry("other", detail.modelUsed ?? model);
            logger.warn?.(
              `memory-hybrid: distill batch ${batchNum} truncated — shrinking and retrying (budget left=${shrinkBudget})`,
            );
            continue;
          }
          if (!opts.dryRun && lengthRetriesAtCursor < maxLengthRetriesPerCursor) {
            lengthRetriesAtCursor++;
            shrinkForRetry("other", detail.modelUsed ?? model);
            if (!adaptiveEnabled) {
              nonAdaptiveBatchFactor *= 0.6;
              nonAdaptiveOutFactor = Math.max(nonAdaptiveOutFactor, 0.5);
            }
            logger.warn?.(
              `memory-hybrid: distill batch ${batchNum} truncated — splitting batch (retry ${lengthRetriesAtCursor}/${maxLengthRetriesPerCursor} at cursor=${cursorBlock})`,
            );
            continue;
          }
          if (!opts.dryRun) {
            logger.warn?.(
              `memory-hybrid: distill batch ${batchNum} truncated — accepting partial output after ${lengthRetriesAtCursor} split retries`,
            );
          }
        }
        const acceptingTruncatedPartial =
          outputTruncated && !opts.dryRun && lengthRetriesAtCursor >= maxLengthRetriesPerCursor;
        if (detail.modelUsed !== model) {
          const src = fallbackSources.get(detail.modelUsed) ?? "fallback";
          logger.info?.(
            `memory-hybrid: distill batch ${batchNum} succeeded with fallback model ${detail.modelUsed} (source=${src})`,
          );
        }
        if (adaptiveEnabled && !opts.dryRun && !outputTruncated && adaptiveStatePath) {
          const usedLimits = effectiveLimitsForModel(detail.modelUsed);
          recordAdaptiveSuccess({
            state: adaptiveState,
            model: detail.modelUsed,
            catalogBatchTokenLimit: distillBatchTokenLimit(detail.modelUsed),
            catalogMaxOutputTokens: distillMaxOutputTokens(detail.modelUsed),
            usedBatchTokenLimit: usedLimits.batchTokenLimit,
            usedMaxOutputTokens: usedLimits.maxOutputTokens,
          });
          persistAdaptiveLimitsToDisk();
        }
        if (!adaptiveEnabled) {
          nonAdaptiveBatchFactor = 1;
          nonAdaptiveOutFactor = 1;
        }

        const content = detail.content;
        const lines = content.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          const jsonMatch = line.match(/\{[\s\S]*\}/);
          if (!jsonMatch) continue;
          try {
            const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
            const category = String(obj.category || "other").toLowerCase();
            const text = String(obj.text || "").trim();
            if (!text || text.length < 10) continue;
            const entity = typeof obj.entity === "string" ? obj.entity : null;
            const key = typeof obj.key === "string" ? obj.key : null;
            const value = typeof obj.value === "string" ? obj.value : entity && key ? text.slice(0, 200) : "";
            const source_date = typeof obj.source_date === "string" ? obj.source_date : null;
            const tags = Array.isArray(obj.tags)
              ? (obj.tags as string[]).filter((t) => typeof t === "string")
              : undefined;
            allFacts.push({
              category,
              text,
              entity: entity ?? undefined,
              key: key ?? undefined,
              value,
              source_date: source_date ?? undefined,
              tags,
            });
          } catch (err) {
            capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:parse-json" });
          }
        }
        let advanceBlocks = batch.count;
        if (acceptingTruncatedPartial && batch.count > 1) {
          advanceBlocks = Math.max(1, Math.floor(batch.count / 2));
          logger.warn?.(
            `memory-hybrid: distill batch ${batchNum} force-split — advancing ${advanceBlocks}/${batch.count} blocks at cursor=${cursorBlock}`,
          );
        }
        cursorBlock += advanceBlocks;
        processedBlocks += advanceBlocks;
        lengthRetriesAtCursor = 0;
        progress.update(processedBlocks);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        // The in-flight call above passes getMaintenanceRunAbortSignal() as `signal`; if the
        // orchestrator-wide deadline fires mid-call, that abort surfaces here as a plain rejected
        // promise, not a special error type. Without this check it fell through to the generic
        // `kind: "other"` branch below, which counts toward hardBatchFailures and turns an expected,
        // resumable deadline stop into a hard "distill partial failure" (#2046) — the same case the
        // pre-batch `maintenanceRunDeadlineReached()` check above already treats as non-blocking.
        if (maintenanceRunDeadlineReached()) {
          sink.warn(`memory-hybrid: distill batch ${batchNum} aborted: maintenance run deadline reached`);
          batchFailures++;
          deadlineTruncated = true;
          batchFailureReason ??= `batch ${batchNum} aborted: maintenance run deadline reached before completion`;
          break;
        }
        const isContext = isContextLengthError(e);
        const isRateLimit = is429OrWrapped(e);
        const isQuota = is403QuotaOrRateLimitLike(e);
        const isTimeout = /timed out|llm request timeout|request was aborted|Request was aborted/i.test(e.message);
        const isConn = isConnectionErrorLike(e);
        const kind = isContext
          ? "context_length"
          : isRateLimit
            ? "rate_limit"
            : isQuota
              ? "quota"
              : isTimeout || isConn
                ? "timeout"
                : "other";
        const failureModel =
          typeof (e as Error & { lastAttemptedModel?: string }).lastAttemptedModel === "string"
            ? (e as Error & { lastAttemptedModel: string }).lastAttemptedModel
            : model;
        // chatCompleteWithRetryDetailed only throws after every model in the chain (primary + all
        // fallbackModels passed to this call) has failed, so a timeout/connection error while the
        // primary was in the chain means the primary itself is confirmed down for this run.
        if (usedPrimaryThisAttempt && (isTimeout || isConn)) {
          primaryUnavailableThisRun = true;
        }
        shrinkForRetry(kind, failureModel);
        const retryAfterMs = parseRetryAfterMs(e);
        if ((isRateLimit || isQuota) && retryAfterMs != null && retryAfterMs > 0) {
          const delay = Math.min(retryAfterMs, 60_000);
          sink.warn(`memory-hybrid: distill batch ${batchNum} rate limited — backing off ${delay}ms`);
          await new Promise<void>((r) => setTimeout(r, delay));
        }
        const canShrinkRetry =
          shrinkBudget > 0 &&
          (isContext || isRateLimit || isQuota || isTimeout || isConn) &&
          !(adaptiveEnabled && opts.dryRun);
        if (canShrinkRetry) {
          shrinkBudget--;
          sink.warn(
            `memory-hybrid: distill batch ${batchNum} failed (${kind}); shrinking and retrying with smaller batch (budget left=${shrinkBudget})`,
          );
          continue;
        }
        sink.warn(`memory-hybrid: distill batch ${batchNum} failed: ${e}`);
        capturePluginError(e, { subsystem: "cli", operation: "runDistillForCli:llm-batch" });
        batchFailures++;
        hardBatchFailures++;
        batchFailureReason ??= `batch ${batchNum} ${kind} error on model ${failureModel}: ${e.message}`;
        if (!adaptiveEnabled) {
          nonAdaptiveBatchFactor = 1;
          nonAdaptiveOutFactor = 1;
        }
        break;
      }
    }
    distillProgress.done({
      status: batchFailures > 0 || truncatedBatches > 0 ? "partial" : allFacts.length === 0 ? "empty" : "ok",
      extracted: allFacts.length,
      processedBlocks,
      batchFailures,
      truncatedBatches,
    });
    progress.done();
    if (truncatedBatches > 0) {
      sink.warn(
        `memory-hybrid: distill truncatedBatches=${truncatedBatches} — some batches hit finish=length; consider resetting .adaptive-llm-limits.json or using --force with smaller --days`,
      );
    }
    // Report how many sessions were actually read, not the full candidate count, when the file-scan
    // phase was cut short by the maintenance-run deadline (#2041 review finding) — otherwise a
    // truncated run's own summary/warnings/job-run ledger claim the full `filesToProcess.length` was
    // scanned, directly contradicting `batchFailureReason`'s "session scan aborted at N/M" message.
    const actualSessionsScanned = filesScanTruncatedAt >= 0 ? filesScanTruncatedAt : filesToProcess.length;
    const semanticEmpty = actualSessionsScanned > 0 && allFacts.length === 0;
    if (semanticEmpty) {
      sink.warn(
        `memory-hybrid: distill semantic_empty: processed ${actualSessionsScanned} session(s) but parsed zero facts`,
      );
    }
    const runSucceeded = batchFailures === 0 && !semanticEmpty;
    const shouldAdvanceCursor = batchFailures === 0 && !semanticEmpty;
    if (opts.dryRun) {
      sink.log(`Would extract ${allFacts.length} facts from ${actualSessionsScanned} sessions`);
      return withDistillJobRun(
        {
          sessionsScanned: actualSessionsScanned,
          factsExtracted: allFacts.length,
          stored: 0,
          dedupSkipped: 0,
          dryRun: true,
          semanticEmpty,
        },
        { semanticEmpty },
      );
    }
    const sourceDateSec = (s: string | null | undefined) => {
      if (!s || typeof s !== "string") return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
      if (!m) return null;
      return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
    };
    let stored = 0;
    let skipped = 0;
    const fuzzyDedupeEnabled = cfg.store.fuzzyDedupe === true;
    let vectorSearchDegraded = false;
    let vectorDedupeStores = 0;
    let lexicalOnlyDedupeStores = 0;
    let usedHasDuplicateFallback = false;
    for (const fact of allFacts) {
      const parsed = tryParseCredentialForVault(fact.text, fact.entity ?? null, fact.key ?? null, fact.value, {
        requirePatternMatch: cfg.credentials.autoCapture?.requirePatternMatch === true,
      });
      if (parsed) {
        if (cfg.credentials.enabled && credentialsDb) {
          let storedInVault = false;
          try {
            const credStoreResult = credentialsDb.storeIfNew({
              service: parsed.service,
              type: parsed.type,
              value: parsed.secretValue,
              url: parsed.url,
              notes: parsed.notes,
            });
            storedInVault = credStoreResult != null;
            const pointer = ensureCredentialVaultPointer(factsDb, parsed.service, parsed.type, "distillation", {
              importance: BATCH_STORE_IMPORTANCE,
              sourceDate: sourceDateSec(fact.source_date),
            });
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
            const entry = pointer.entry;
            const pointerText = buildCredentialPointerText(parsed.service, parsed.type);
            // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
            await cleanupEvictedVector({
              vectorDb: vectorDb,
              evictedFactId: pointer.evictedFactId,
              logger: sink,
              context: "distill",
            });
            if (pointer.newlyStored || pointer.embeddingStale) {
              try {
                const vector = await embeddings.embed(pointerText);
                factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
                if (!(await vectorDb.hasDuplicate(vector, DISTILL_DEDUP_THRESHOLD))) {
                  await vectorDb.store({
                    text: pointerText,
                    vector,
                    importance: BATCH_STORE_IMPORTANCE,
                    category: "technical",
                    id: entry.id,
                  });
                }
              } catch (err) {
                capturePluginError(err as Error, {
                  subsystem: "cli",
                  operation: "runDistillForCli:credential-vector-store",
                });
              }
            }
            stored++;
            if (opts.verbose) sink.log(`  stored credential: ${parsed.service}`);
          } catch (err) {
            if (storedInVault) {
              rollbackVaultCredentialWrite(credentialsDb, parsed.service, parsed.type, (message, cleanupErr) => {
                if (opts.verbose) sink.log(`  ${message}: ${cleanupErr}`);
                capturePluginError(cleanupErr as Error, {
                  subsystem: "cli",
                  operation: "runDistillForCli:credential-compensating-delete",
                });
              });
            }
            capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:credential-store" });
          }
          continue;
        }
        if (opts.verbose) sink.log("  skipped credential-like fact: vault disabled or unavailable");
        continue;
      }

      // When requirePatternMatch rejects vault parsing but the input is still credential-like,
      // skip ordinary storage to prevent plaintext secrets in facts.db (#1896).
      if (
        !parsed &&
        cfg.credentials.autoCapture?.requirePatternMatch === true &&
        isStructuredCredentialCandidate(fact.text, fact.entity ?? null, fact.key ?? null, fact.value)
      ) {
        if (opts.verbose) sink.log("  skipped credential-like fact: blocked by requirePatternMatch");
        continue;
      }

      const category = (isValidCategory(fact.category) ? fact.category : "other") as MemoryCategory;
      const entity = fact.entity ?? null;
      const key = fact.key ?? null;
      const redactionCtx = { category, key };
      const redactedText = maybeRedactMaintenanceFactText(fact.text, cfg.maintenance?.privacyRedaction, redactionCtx);
      const redactedValue = fact.value
        ? maybeRedactMaintenanceFactText(fact.value, cfg.maintenance?.privacyRedaction, redactionCtx)
        : redactedText.slice(0, 200);

      if (
        factsDb.hasDuplicate(redactedText, "distillation", {
          category,
          entity,
          key,
          value: redactedValue,
        })
      ) {
        skipped++;
        continue;
      }
      try {
        const vector = await embeddings.embed(redactedText);
        const embeddingModelName =
          typeof embeddings.modelName === "string" && embeddings.modelName.trim().length > 0
            ? embeddings.modelName
            : null;
        const vectorResolve = await resolveDistillVectorCandidates({
          fuzzyDedupe: fuzzyDedupeEnabled,
          vector,
          vectorDb,
          factsDb,
          embeddingModelName,
        });
        vectorSearchDegraded = vectorSearchDegraded || vectorResolve.vectorSearchDegraded;
        if (vectorResolve.usedHasDuplicateFallback) {
          usedHasDuplicateFallback = true;
        }
        if (vectorResolve.skipAsDuplicate) {
          skipped++;
          continue;
        }
        if (!fuzzyDedupeEnabled && (await vectorDb.hasDuplicate(vector, DISTILL_DEDUP_THRESHOLD))) {
          skipped++;
          continue;
        }
        const storeResult = factsDb.storeWithResult(
          {
            text: redactedText,
            category,
            importance: BATCH_STORE_IMPORTANCE,
            entity,
            key,
            value: redactedValue,
            source: "distillation",
            sourceDate: sourceDateSec(fact.source_date),
            tags: fact.tags?.length ? fact.tags : extractTags(redactedText, fact.entity ?? undefined),
          },
          {
            vectorCandidates: vectorResolve.vectorCandidates,
            warnContext: "distill",
            suppressVectorFallbackWarning: true,
          },
        );
        const factDedupeMode = classifyStoreDedupeMode({
          fuzzyDedupe: fuzzyDedupeEnabled,
          vectorSearchDegraded: vectorResolve.vectorSearchDegraded,
          vectorCandidates: vectorResolve.vectorCandidates,
          usedHasDuplicateFallback: vectorResolve.usedHasDuplicateFallback,
          skipAsDuplicate: vectorResolve.skipAsDuplicate,
        });
        if (factDedupeMode === "vector") {
          vectorDedupeStores++;
        } else if (factDedupeMode === "mixed") {
          vectorDedupeStores++;
          lexicalOnlyDedupeStores++;
        } else {
          lexicalOnlyDedupeStores++;
        }
        if (storeResult.skipped) {
          skipped++;
          continue;
        }
        if (storeResult.newlyStored === false && !storeResult.embeddingStale) {
          skipped++;
          continue;
        }
        const entry = storeResult.entry;
        // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
        await cleanupEvictedVector({
          vectorDb: vectorDb,
          evictedFactId: storeResult.evictedFactId,
          logger: sink,
          context: "distill",
        });
        try {
          await vectorDb.store({
            text: redactedText,
            vector,
            importance: BATCH_STORE_IMPORTANCE,
            category: fact.category,
            id: entry.id,
          });
          factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
        } catch (err) {
          sink.warn(`memory-hybrid: distill vector store failed for "${fact.text.slice(0, 40)}...": ${err}`);
          capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:vector-store" });
        }
        stored++;
        if (opts.verbose) sink.log(`  stored: [${fact.category}] ${fact.text.slice(0, 60)}...`);
      } catch (err) {
        sink.warn(`memory-hybrid: distill store failed for "${fact.text.slice(0, 40)}...": ${err}`);
        capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:store-fact" });
      }
    }
    try {
      if (runSucceeded) {
        runRecordDistillForCli(ctx);
      }
    } catch (err) {
      sink.warn(`memory-hybrid: failed to record distill timestamp: ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:record-timestamp" });
    }
    if (!opts.dryRun && shouldAdvanceCursor) {
      // Use allCandidatePaths (pre-filter input) so skipped sessions advance the watermark.
      const lastSessionTs = getMaxMtime(allCandidatePaths);
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, allCandidatePaths.length);
    } else if (!opts.dryRun && semanticEmpty) {
      sink.warn(
        `memory-hybrid: distill semantic_empty: scan cursor not advanced (${filesToProcess.length} session(s) remain eligible for retry)`,
      );
    } else if (batchFailures > 0) {
      sink.warn(`memory-hybrid: distill partial failure: ${batchFailures} batch(es) failed; scan cursor not advanced`);
    }
    const dedupeDegraded = vectorSearchDegraded;
    const distillDedupeMode =
      vectorDedupeStores > 0 && lexicalOnlyDedupeStores > 0
        ? "mixed"
        : vectorDedupeStores > 0
          ? "vector"
          : "lexical-only";
    if (dedupeDegraded && !opts.dryRun) {
      sink.warn(
        `memory-hybrid: distill DEGRADED — vector neighbour search unavailable${usedHasDuplicateFallback ? "; used hasDuplicate fallback where applicable" : ""}`,
      );
    }
    // Only genuine implementation/model errors (hardBatchFailures) and output-truncation quality
    // issues fail the step. A run that stopped solely because the maintenance-run deadline was
    // reached — with no other error — is resumable, checkpointed work-in-progress, not a failure (#2043).
    const partialFailure = hardBatchFailures > 0 || truncatedBatches > 0;
    const deadlineLimitedOnly = !partialFailure && deadlineTruncated;
    const resolvedFailureReason =
      batchFailureReason ??
      (truncatedBatches > 0
        ? `${truncatedBatches} batch(es) hit finish=length (output truncated); consider resetting adaptive limits or smaller --days`
        : undefined);
    return withDistillJobRun(
      {
        sessionsScanned: actualSessionsScanned,
        factsExtracted: allFacts.length,
        stored,
        dedupSkipped: skipped,
        dryRun: false,
        semanticEmpty,
        partialFailure,
        batchFailures,
        batchFailureReason: resolvedFailureReason,
        dedupeDegraded,
        distillDedupeMode,
      },
      partialFailure
        ? { reason: resolvedFailureReason }
        : deadlineLimitedOnly
          ? { monitoring: true, reason: batchFailureReason }
          : undefined,
    );
  } finally {
    if (shouldAcquireLock && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}
