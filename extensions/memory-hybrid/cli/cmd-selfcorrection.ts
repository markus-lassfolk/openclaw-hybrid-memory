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

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  getCronModelConfig,
  getDefaultCronModel,
  resolveReflectionModelAndFallbacks,
  type SelfCorrectionConfig,
} from "../config.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "../services/adaptive-maintenance-llm.js";
import { maintenanceMaxOutputTokens } from "../services/chat.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import { capturePluginError } from "../services/error-reporter.js";
import { emitPipelinePersonaProposed } from "../services/change-feed-emit.js";
import {
  appendUniqueRemediationsByIncidentIndex,
  attachOrderedItemsToIncidents,
  globalIncidentOffsetForBatch,
  orderBatchItemsByIncidentIndex,
  serializeIncidentsForBatchPrompt,
} from "../services/batch-incident-analysis.js";
import { inferFinishReasonFromLlmContent } from "../services/incident-batch-analyze-core.js";
import {
  analyzeSelfCorrectionIncidentBatchWithSplit,
  resolveSelfCorrectionBatchDelayMs,
  resolveSelfCorrectionBatchSize,
  resolveSelfCorrectionThinkingMode,
  type SelfCorrectionRemediationItem,
} from "../services/self-correction-batch-analyze.js";
import {
  type CorrectionIncident,
  collectHeuristicFeedbackCandidates,
  mergeCorrectionIncidents,
  runSelfCorrectionExtract,
} from "../services/self-correction-extract.js";
import { classifyAndFilterCorrectionIncidents } from "../services/feedback-signal-classifier.js";
import { preFilterSessions } from "../services/session-pre-filter.js";
import { insertRulesUnderSection } from "../services/tools-md-section.js";
import { applyToolsMdRules } from "../services/tools-md-rewrite.js";
import { formatSkillUpdateProposal } from "../services/corrections-report.js";
import { resolveCliWorkspaceRoot } from "../utils/cli-workspace-root.js";
import { serializeWorkspaceSkillTargetsForPrompt } from "../utils/skill-discovery.js";
import { cleanupEvictedVector } from "../services/vector-maintenance.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import {
  finishSelfCorrectionJobRun,
  loadSelfCorrectionBatchResume,
  persistSelfCorrectionBatchState,
  removeLegacySelfCorrectionState,
} from "../services/maintenance-job-run/self-correction-bridge.js";
import { MaintenanceJobRun } from "../services/maintenance-job-run/job-run.js";
import { selfCorrectionStatusToJobRunOutcome } from "../services/maintenance-job-run/semantic-outcome.js";
import { formatDateUtc, nowIso } from "../utils/dates.js";
import { maintenanceRunDeadlineReached } from "../utils/maintenance-run-deadline.js";
import { CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import { getCorrectionSignalRegex } from "../utils/language-keywords.js";
import { parseSelfCorrectionLLMResponse } from "../services/self-correction-llm-parser.js";
import { resolveTierPreferenceWithSources } from "../utils/llm-selection.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { estimateTokens } from "../utils/text.js";
import { gatherSessionFiles } from "./cmd-distill.js";
import { getMaxMtime } from "./cmd-extract-sessions.js";
import { buildPreFilterConfig } from "./cmd-install.js";
import { inferTargetFile } from "./cmd-store.js";
import { resolvePipelineProposalTarget } from "./proposals.js";
import { workshopStoresFromHandlerContext } from "../services/unified-proposals.js";
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
  /** Set when merging batch output — ties remediation to a source incident. */
  incidentIndex?: number;
  sourceIncident?: CorrectionIncident;
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
  batchSplits: number;
  truncations: number;
};

const SELF_CORRECTION_BATCH_STATE_VERSION = 1;

/** Resume state files under `<workspace>/tmp/self-correction/`. */
export const SELF_CORRECTION_BATCH_STATE_PREFIX = "m3-batches-";

export function resolveSelfCorrectionBatchStateDir(workspaceRoot: string): string {
  return join(workspaceRoot, "tmp", "self-correction");
}

function isSelfCorrectionBatchStateFile(name: string): boolean {
  return name.startsWith(SELF_CORRECTION_BATCH_STATE_PREFIX) && name.endsWith(".json");
}

function buildSelfCorrectionRunFingerprint(
  incidents: CorrectionIncident[],
  model: string,
  batchSize: number,
  opts: { dryRun?: boolean; applyTools?: boolean },
): string {
  return stableSelfCorrectionHash(
    JSON.stringify({
      incidents,
      model,
      batchSize,
      dryRun: !!opts.dryRun,
      applyTools: opts.applyTools !== false,
    }),
  );
}

function ensureSelfCorrectionStateDir(workspaceRoot: string): string {
  const dir = resolveSelfCorrectionBatchStateDir(workspaceRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function pruneStaleSelfCorrectionStateFiles(stateDir: string, keepPath: string): void {
  try {
    for (const name of readdirSync(stateDir)) {
      if (!isSelfCorrectionBatchStateFile(name)) continue;
      const fullPath = join(stateDir, name);
      if (fullPath === keepPath) continue;
      rmSync(fullPath, { force: true });
    }
  } catch {
    /* best-effort cleanup */
  }
}

function removeSelfCorrectionBatchState(statePath: string): void {
  if (!existsSync(statePath)) return;
  try {
    rmSync(statePath, { force: true });
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:cleanup-state" });
  }
}

function stableSelfCorrectionHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function emptySelfCorrectionDiagnostics(): SelfCorrectionRunDiagnostics {
  return {
    retries: 0,
    fallbacks: 0,
    parseFailures: 0,
    unparseableFailures: 0,
    parsedItems: 0,
    batchSplits: 0,
    truncations: 0,
  };
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
        batchSplits: Number.isFinite(diagnostics.batchSplits) ? diagnostics.batchSplits : 0,
        truncations: Number.isFinite(diagnostics.truncations) ? diagnostics.truncations : 0,
      },
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
    };
  } catch {
    return null;
  }
}

function writeSelfCorrectionBatchState(statePath: string, state: SelfCorrectionBatchState): void {
  atomicWriteFile(statePath, `${JSON.stringify({ ...state, updatedAt: nowIso() }, null, 2)}\n`);
}

function chunkSelfCorrectionIncidents<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));
  return batches;
}

async function sleepSelfCorrectionBackoff(ms: number): Promise<void> {
  if (maintenanceRunDeadlineReached()) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Module-level constants (self-correction-specific)
// ---------------------------------------------------------------------------

/** Maximum number of remediation items to auto-apply per run. */
const SELF_CORRECTION_CAP = 5;

/** Default self-correction configuration values. */
const DEFAULT_SELF_CORRECTION: SelfCorrectionConfig = {
  semanticDedup: true,
  semanticDedupThreshold: 0.92,
  toolsSection: "Self-correction rules",
  applyToolsByDefault: true,
  autoRewriteTools: false,
  analyzeViaSpawn: false,
  spawnThreshold: 15,
  spawnModel: "",
  llmExtract: true,
  llmExtractMinConfidence: 0.6,
};

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
export { parseSelfCorrectionLLMResponse } from "../services/self-correction-llm-parser.js";

type SelfCorrectionApplyResult = {
  autoFixed: number;
  proposals: string[];
  toolsSuggestions: string[];
  toolsApplied: number;
};

async function applySelfCorrectionRemediations(params: {
  ctx: HandlerContext;
  analysed: SelfCorrectionRemediation[];
  incidents: CorrectionIncident[];
  workspaceRoot: string;
  scCfg: SelfCorrectionConfig;
  opts: {
    dryRun?: boolean;
    approve?: boolean;
    applyTools?: boolean;
  };
  model: string;
  modelSource: string;
  scFallbackModels: string[];
}): Promise<SelfCorrectionApplyResult> {
  const { ctx, analysed, incidents, workspaceRoot, scCfg, opts, model, modelSource, scFallbackModels } = params;
  const { factsDb, vectorDb, embeddings, openai, proposalsDb, logger } = ctx;
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
        const storeResult = factsDb.storeWithResult(
          {
            text,
            category: "technical",
            importance: CLI_STORE_IMPORTANCE,
            entity: obj.entity ?? null,
            key: typeof obj.key === "string" ? obj.key : null,
            value: text.slice(0, 200),
            source: "self-correction",
            tags: Array.isArray(obj.tags) ? obj.tags : [],
          },
          { suppressVectorFallbackWarning: true },
        );
        if (storeResult.skipped) continue;
        if (storeResult.newlyStored === false && !storeResult.embeddingStale) continue;
        const entry = storeResult.entry;
        await cleanupEvictedVector({
          vectorDb,
          evictedFactId: storeResult.evictedFactId,
          logger,
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
        const proposalLine =
          a.remediationType === "SKILL_UPDATE"
            ? formatSkillUpdateProposal(line, workspaceRoot)
            : `[${a.remediationType}] ${line.trim()}`;
        proposals.push(proposalLine);
        if (
          a.remediationType === "AGENTS_RULE" &&
          proposalsDb &&
          scCfg.agentsRuleToProposals !== false &&
          !opts.dryRun
        ) {
          try {
            const lineText = line.trim();
            const targetFile = inferTargetFile(lineText);
            const resolved = resolvePipelineProposalTarget({
              targetFile,
              suggestedChange: lineText,
              allowedFiles: ctx.cfg.personaProposals.allowedFiles,
              workspaceRoot,
              confidence: 0.7,
              proposalTTLDays: ctx.cfg.personaProposals.proposalTTLDays,
              minConfidence: ctx.cfg.personaProposals.minConfidence,
              proposalsDb,
              workshopStores: workshopStoresFromHandlerContext(ctx),
            });
            if (!resolved) continue;
            const src =
              a.sourceIncident ??
              (typeof a.incidentIndex === "number" && incidents[a.incidentIndex]
                ? incidents[a.incidentIndex]
                : incidents[0]);
            const incidentContext = src
              ? `Correction incident: "${src.userMessage.slice(0, 200)}"`
              : "Self-correction analysis";
            const evidenceSessions = src
              ? [src.sessionFile]
              : incidents.map((inc) => inc.sessionFile).filter((v, idx, arr) => arr.indexOf(v) === idx);
            const created = proposalsDb.create({
              targetFile: resolved.targetFile,
              title: `Self-correction: ${a.category ?? "behavior"}`,
              observation: incidentContext,
              suggestedChange: lineText,
              confidence: resolved.confidence,
              evidenceSessions,
              expiresAt: resolved.expiresAt,
              targetMtimeMs: resolved.targetMtimeMs,
              targetHash: resolved.targetHash,
            });
            emitPipelinePersonaProposed(ctx.changeFeed, ctx.cfg, created, incidentContext);
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
  if (toolsSuggestions.length > 0 && shouldApplyTools) {
    try {
      if (scCfg.autoRewriteTools) {
        const currentTools = existsSync(toolsPath) ? readFileSync(toolsPath, "utf-8") : "";
        const rewritePrompt = fillPrompt(loadPrompt("self-correction-rewrite-tools"), {
          current_tools: currentTools || "# TOOLS\n",
          new_rules: toolsSuggestions.join("\n"),
        });
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
          thinkingMode: resolveSelfCorrectionThinkingMode(ctx.cfg),
        });
        const applyResult = applyToolsMdRules({
          toolsPath,
          sectionTitle: toolsSection,
          newRules: toolsSuggestions,
          autoRewrite: true,
          rewrittenContent: detail.content,
        });
        if (applyResult.rewriteRejectedReasons?.length) {
          logger.warn?.(
            `memory-hybrid: self-correction TOOLS rewrite rejected (${applyResult.rewriteRejectedReasons.join("; ")}); used section insert`,
          );
        }
        toolsApplied = applyResult.toolsApplied;
        autoFixed += applyResult.toolsApplied;
      } else {
        const applyResult = applyToolsMdRules({
          toolsPath,
          sectionTitle: toolsSection,
          newRules: toolsSuggestions,
          autoRewrite: false,
        });
        toolsApplied = applyResult.toolsApplied;
        autoFixed += applyResult.toolsApplied;
      }
    } catch (err) {
      logger.warn?.(`memory-hybrid: self-correction TOOLS apply failed: ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:insert-tools" });
    }
  }

  return { autoFixed, proposals, toolsSuggestions, toolsApplied };
}

function buildSelfCorrectionReportLines(params: {
  today: string;
  incidentsCount: number;
  analysed: SelfCorrectionRemediation[];
  autoFixed: number;
  proposals: string[];
  toolsSuggestions: string[];
  toolsApplied: number;
  diagnostics: SelfCorrectionRunDiagnostics;
  scCfg: SelfCorrectionConfig;
}): string[] {
  const { today, incidentsCount, analysed, autoFixed, proposals, toolsSuggestions, toolsApplied, diagnostics, scCfg } =
    params;
  return [
    `# Self-Correction Analysis (${today})`,
    "",
    `Scanned: last 3 days. Incidents found: ${incidentsCount}.`,
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
      ? ["## TOOLS.md updated", "", `- ${toolsApplied} rule(s) inserted under section "${scCfg.toolsSection}".`, ""]
      : []),
    ...(proposals.length > 0
      ? ["## Proposed (review before applying)", "", ...proposals.map((p) => `- ${p}`), ""]
      : []),
  ];
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
    days?: number;
    model?: string;
    approve?: boolean;
    applyTools?: boolean;
    full?: boolean;
    force?: boolean;
    verbose?: boolean;
    /** Override JobRun artifact root (tests). */
    jobRunLogRoot?: string;
  },
): Promise<SelfCorrectionRunResult> {
  const { bypassScanCooldown } = resolveScanMaintenanceOverrides(opts);
  const { factsDb, openai, cfg, logger } = ctx;
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
    const workspaceRoot = resolveCliWorkspaceRoot({ workspace: opts.workspace });
    const scCfg = cfg.selfCorrection ?? DEFAULT_SELF_CORRECTION;
    const reportDir = join(workspaceRoot, "memory", "reports");
    const today = formatDateUtc(Math.floor(Date.now() / 1000));
    const reportPath = join(reportDir, `self-correction-${today}.md`);
    let incidents: CorrectionIncident[];
    let extractSessionsScanned = 0;
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
      const scanDays = opts.days ?? 3;
      const pfCfgSC = buildPreFilterConfig(cfg);
      if (pfCfgSC.enabled) {
        const sessionFiles = gatherSessionFiles({ days: scanDays });
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
        days: scanDays,
        filePaths: scFilePaths,
        verbose: opts.verbose,
      });
      extractSessionsScanned = extractResult.sessionsScanned;
      incidents = extractResult.incidents;
      const scCfgExtract = cfg.selfCorrection ?? DEFAULT_SELF_CORRECTION;
      if (scCfgExtract.llmExtract !== false && incidents.length >= 0) {
        const correctionRegex = getCorrectionSignalRegex();
        const pathsForHeuristic =
          scFilePaths ?? gatherSessionFiles({ days: scanDays }).map((f: { path: string }) => f.path);
        const heuristic = collectHeuristicFeedbackCandidates({
          filePaths: pathsForHeuristic,
          correctionRegex,
        });
        incidents = mergeCorrectionIncidents(incidents, heuristic.slice(0, 80));
        if (incidents.length > 0) {
          const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(
            cfg,
            "maintenance",
            scCfgExtract.model,
          );
          const filtered = await classifyAndFilterCorrectionIncidents({
            incidents,
            openai,
            model: scCfgExtract.model ?? defaultModel,
            fallbackModels,
            minConfidence: scCfgExtract.llmExtractMinConfidence ?? 0.6,
            batchSize: 10,
            factsDb,
            logger: {
              info: (msg) => logger.info?.(msg),
              warn: (msg) => logger.warn?.(msg),
            },
          });
          incidents = filtered.incidents;
        }
      }
    }
    if (incidents.length === 0) {
      const scanDays = opts.days ?? 3;
      const emptyReport = `# Self-Correction Analysis (${today})\n\nScanned sessions: ${scanDays} days.\nIncidents found: 0.\n`;
      if (!opts.dryRun) {
        try {
          atomicWriteFile(reportPath, emptyReport);
        } catch (err) {
          capturePluginError(err as Error, {
            subsystem: "cli",
            operation: "runSelfCorrectionRunForCli:write-empty-report",
          });
        }
      }
      if (!opts.dryRun && !opts.incidents && !opts.extractPath) {
        factsDb.updateScanCursor(SCAN_TYPE, 0, 0);
        clearScanLock(SCAN_TYPE);
      }
      let emptyJobRun: MaintenanceJobRun | null = null;
      if (!opts.dryRun) {
        emptyJobRun = MaintenanceJobRun.create({
          command: SCAN_TYPE,
          inputFingerprint: stableSelfCorrectionHash(JSON.stringify({ scanDays, empty: true })),
          resumeCommand: "openclaw hybrid-mem self-correction run",
          logRoot: opts.jobRunLogRoot,
        });
        emptyJobRun.startPhase("extract");
        emptyJobRun.endPhase("extract", "completed", "incidents=0");
      }
      const emptyJobRunId = finishSelfCorrectionJobRun(emptyJobRun, "success_no_incidents");
      return {
        incidentsFound: 0,
        analysed: 0,
        autoFixed: 0,
        proposals: [],
        reportPath: opts.dryRun ? null : reportPath,
        status: "success_no_incidents",
        jobRunId: emptyJobRunId,
        semanticOutcome: "empty",
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
    const maxTokens = maintenanceMaxOutputTokens(model);
    const batchSize = resolveSelfCorrectionBatchSize(model, scCfg);
    const batchDelayMs = resolveSelfCorrectionBatchDelayMs(scCfg);
    const thinkingMode = resolveSelfCorrectionThinkingMode(cfg);
    let analysed: SelfCorrectionRemediation[] = [];
    const diagnostics = emptySelfCorrectionDiagnostics();
    const batches = chunkSelfCorrectionIncidents(incidents, batchSize);
    const runFingerprint = buildSelfCorrectionRunFingerprint(incidents, model, batchSize, opts);
    const stateDir = resolveSelfCorrectionBatchStateDir(workspaceRoot);
    const legacyStatePath = join(stateDir, `${SELF_CORRECTION_BATCH_STATE_PREFIX}${runFingerprint}.json`);
    let jobRun: MaintenanceJobRun | null = null;
    if (!opts.dryRun) {
      ensureSelfCorrectionStateDir(workspaceRoot);
      pruneStaleSelfCorrectionStateFiles(stateDir, legacyStatePath);
      jobRun = MaintenanceJobRun.create({
        command: SCAN_TYPE,
        inputFingerprint: runFingerprint,
        modelPolicy: { model, fallbacks: scFallbackModels },
        resumeCommand: "openclaw hybrid-mem self-correction run",
        logRoot: opts.jobRunLogRoot,
      });
      jobRun.startPhase("extract");
      jobRun.endPhase("extract", "completed", `incidents=${incidents.length}`);
      jobRun.startPhase("analyze");
    }
    const completedBatchIndexes = new Set<number>();
    let batchesStarted = 0;
    if (!opts.dryRun && jobRun) {
      const resumeState = loadSelfCorrectionBatchResume<SelfCorrectionRemediation>(
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
        batchesStarted = completedBatchIndexes.size;
        logger.info?.(
          `memory-hybrid: ${SCAN_TYPE} — MiniMax batch mode: ${batches.length} batch(es), size=${batchSize}`,
        );
        logger.info?.(
          `memory-hybrid: ${SCAN_TYPE} — JobRun resume ${jobRun.jobRunId}; checkpoint=${jobRun.checkpointPath}; completed=${completedBatchIndexes.size}`,
        );
        if (opts.verbose && completedBatchIndexes.size > 0) {
          logger.info?.(
            `memory-hybrid: ${SCAN_TYPE} resume state: skipping ${completedBatchIndexes.size}/${batches.length} completed batch(es)`,
          );
        }
      } else {
        logger.info?.(
          `memory-hybrid: ${SCAN_TYPE} — MiniMax batch mode: ${batches.length} batch(es), size=${batchSize}`,
        );
        logger.info?.(`memory-hybrid: ${SCAN_TYPE} — JobRun ${jobRun.jobRunId}; completed=0`);
      }
    } else {
      logger.info?.(
        `memory-hybrid: ${SCAN_TYPE} — batch mode: ${batches.length} batch(es), size=${batchSize} (dry-run; resume disabled)`,
      );
    }

    const persistBatchState = () => {
      if (opts.dryRun || !jobRun) return;
      persistSelfCorrectionBatchState(jobRun, {
        incidentsHash: runFingerprint,
        batchSize,
        totalBatches: batches.length,
        completedBatchIndexes: [...completedBatchIndexes].sort((a, b) => a - b),
        analysed,
        diagnostics: { ...diagnostics },
      });
    };

    const logTransientRetry = (batchIndex: number, attempt: number, delayMs: number, err: unknown) => {
      logger.warn?.(
        `memory-hybrid: ${SCAN_TYPE} batch ${batchIndex >= 0 ? `${batchIndex + 1}/${batches.length}` : "repair"} attempt ${attempt} failed: ${String(
          err,
        ).slice(0, 240)}; retrying in ${delayMs}ms without lowering maxTokens`,
      );
    };

    try {
      const adaptiveEnabled = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
      const adaptiveStatePath =
        ctx.resolvedSqlitePath && ctx.resolvedSqlitePath.length > 0
          ? join(dirname(ctx.resolvedSqlitePath), ".adaptive-llm-limits.json")
          : undefined;

      const attemptAnalysisJsonRepair = async (
        rawContent: string,
      ): Promise<{ items: SelfCorrectionRemediation[] | null; fallbacks: number }> => {
        const repairPrompt = [
          "Convert the following model output into a valid JSON array.",
          "Return ONLY JSON (no markdown, no prose).",
          "Each item must include incidentIndex (0-based) when incidents were batched.",
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
          maxTokens,
          openai,
          fallbackModels: scFallbackModels,
          label: "memory-hybrid: self-correction analyze-repair",
          feature: CostFeature.selfCorrectionAnalyze,
          logger,
          adaptiveStatePath,
          enabled: adaptiveEnabled,
          thinkingMode,
          onRetry: (info) => logTransientRetry(-1, info.attempt, info.delayMs, info.error),
        });
        const repaired = parseSelfCorrectionLLMResponse(detail.content);
        return {
          items: repaired === null ? null : (repaired as SelfCorrectionRemediation[]),
          fallbacks: detail.modelUsed !== model ? 1 : 0,
        };
      };

      const availableSkillsJson = serializeWorkspaceSkillTargetsForPrompt(workspaceRoot);
      const analyzeDeps = {
        model,
        modelSource,
        openai,
        scFallbackModels,
        maxTokens,
        thinkingMode,
        adaptiveEnabled,
        adaptiveStatePath,
        logger,
        availableSkillsJson,
        onTransientRetry: (info: { attempt: number; delayMs: number; error: Error }) => {
          logTransientRetry(-1, info.attempt, info.delayMs, info.error);
        },
        attemptAnalysisJsonRepair,
      };

      const fetchSpawnBatchContent = async (prompt: string, outputTokenBudget?: number): Promise<string> => {
        const { spawnSync } = await import("node:child_process");
        const { tmpdir: osTmp } = await import("node:os");
        const { extractAssistantMessageText } = await import("../utils/llm-message.js");
        const budgetLine =
          outputTokenBudget != null && Number.isFinite(outputTokenBudget)
            ? `\n\nOUTPUT TOKEN BUDGET: Keep the JSON array response within approximately ${outputTokenBudget} output tokens.\n`
            : "";
        const promptPath = join(osTmp(), `self-correction-prompt-${Date.now()}.txt`);
        writeFileSync(promptPath, prompt + budgetLine, "utf-8");
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
        const rawContent = (r.stdout ?? "") + (r.stderr ?? "");
        if (r.status !== 0) throw new Error(`sessions spawn exited ${r.status}: ${rawContent.slice(0, 500)}`);
        try {
          const parsed = JSON.parse(rawContent);
          if (parsed && typeof parsed === "object" && "choices" in parsed && Array.isArray(parsed.choices)) {
            const firstChoice = parsed.choices[0];
            if (firstChoice && typeof firstChoice === "object" && "message" in firstChoice) {
              const extracted = extractAssistantMessageText(firstChoice.message);
              if (extracted.text) return extracted.text;
            }
          }
        } catch {
          /* not API-shaped JSON; use raw */
        }
        return rawContent;
      };

      const spawnInputTokenThreshold = 100_000;

      const processBatchResult = async (
        batchIndex: number,
        batch: CorrectionIncident[],
        globalIncidentOffset: number,
      ): Promise<void> => {
        const batchLabel = `batch ${batchIndex + 1}/${batches.length}`;
        const useSpawnForBatch =
          scCfg.analyzeViaSpawn && estimateTokens(JSON.stringify(batch)) > spawnInputTokenThreshold;

        const result = await analyzeSelfCorrectionIncidentBatchWithSplit(
          {
            ...analyzeDeps,
            batchLabel,
            ...(useSpawnForBatch
              ? {
                  llmCall: async (spawnBatch, _batchLabel, maxTokensOverride) => {
                    const prompt = fillPrompt(loadPrompt("self-correction-analyze"), {
                      incidents_json: serializeIncidentsForBatchPrompt(spawnBatch),
                      available_skills_json: availableSkillsJson,
                    });
                    const outputBudget = maxTokensOverride ?? maxTokens;
                    if (maxTokensOverride != null && maxTokensOverride !== maxTokens) {
                      logger.info?.(
                        `memory-hybrid: ${SCAN_TYPE} spawn analyze: maxTokens bump ${maxTokens} → ${maxTokensOverride}`,
                      );
                    }
                    const content = await fetchSpawnBatchContent(prompt, outputBudget);
                    const finishReason = inferFinishReasonFromLlmContent(content);
                    return { content, fallbacks: 0, finishReason };
                  },
                }
              : {}),
          },
          batch,
        );
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
              persistBatchState();
              return;
            }
            const synthesized: SelfCorrectionRemediationItem[] = batch.map((_, localIdx) => ({
              incidentIndex: localIdx,
              remediationType: "NO_ACTION",
              category: "",
              severity: "",
              remediationContent: "",
            }));
            const ordered = orderBatchItemsByIncidentIndex(batch.length, synthesized, logger, globalIncidentOffset);
            if (ordered === null) {
              diagnostics.unparseableFailures++;
              const emptyError = new Error(
                `Self-correction analysis: ${batchLabel} empty [] response could not be mapped to incidents.`,
              );
              (emptyError as any).isParseFailure = true;
              throw emptyError;
            }
            const attached = attachOrderedItemsToIncidents<CorrectionIncident, SelfCorrectionRemediationItem>(
              batch,
              ordered,
              globalIncidentOffset,
            );
            const added = appendUniqueRemediationsByIncidentIndex(analysed, attached);
            diagnostics.parsedItems += added;
            completedBatchIndexes.add(batchIndex);
            logger.info?.(`memory-hybrid: ${SCAN_TYPE} analyze ${batchLabel}: parsed_items=${attached.length}`);
            persistBatchState();
            return;
          }
          diagnostics.unparseableFailures++;
          const excerpt = sanitizeLlmResponseExcerpt(result.rawContent ?? "");
          const parseError = new Error(
            `Self-correction analysis: ${batchLabel} LLM response could not be parsed as a JSON array (repair failed). excerpt="${excerpt}"`,
          );
          (parseError as any).isParseFailure = true;
          throw parseError;
        }
        const ordered = orderBatchItemsByIncidentIndex(batch.length, result.items, logger, globalIncidentOffset);
        if (ordered === null) {
          diagnostics.unparseableFailures++;
          const coverageError = new Error(
            `Self-correction analysis: ${batchLabel} incomplete after auto-split (expected ${batch.length} remediation item(s), could not assign one per incident).`,
          );
          (coverageError as any).isParseFailure = true;
          throw coverageError;
        }

        diagnostics.fallbacks += result.diagnostics.fallbacks;
        diagnostics.parseFailures += result.diagnostics.parseFailures;
        diagnostics.batchSplits += result.diagnostics.batchSplits;
        diagnostics.truncations += result.diagnostics.truncations;
        diagnostics.retries += result.diagnostics.retries;

        const attached = attachOrderedItemsToIncidents<CorrectionIncident, SelfCorrectionRemediationItem>(
          batch,
          ordered,
          globalIncidentOffset,
        );
        const added = appendUniqueRemediationsByIncidentIndex(analysed, attached);
        diagnostics.parsedItems += added;
        completedBatchIndexes.add(batchIndex);
        logger.info?.(`memory-hybrid: ${SCAN_TYPE} analyze ${batchLabel}: parsed_items=${attached.length}`);
        persistBatchState();
      };

      logger.info?.("memory-hybrid: self-correction-run model tier = heavy");
      logger.info?.(`memory-hybrid: self-correction-run starting with model ${model} (source=${modelSource})`);
      logger.info?.(
        `memory-hybrid: self-correction-run fallback chain = [${scFallbackModels.length > 0 ? scFallbackModels.join(", ") : ""}]`,
      );
      logger.info?.(
        `memory-hybrid: self-correction-run batch mode: size=${batchSize} delayMs=${batchDelayMs} thinking=${thinkingMode} maxTokens=${maxTokens}`,
      );

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        if (maintenanceRunDeadlineReached()) {
          logger.warn?.(
            `memory-hybrid: ${SCAN_TYPE} stopped — maintenance run deadline reached`,
          );
          break;
        }
        if (completedBatchIndexes.has(batchIndex)) continue;
        const batch = batches[batchIndex];
        const globalIncidentOffset = globalIncidentOffsetForBatch(batches, batchIndex);
        batchesStarted++;
        logger.info?.(
          `memory-hybrid: ${SCAN_TYPE} batch ${batchIndex + 1}/${batches.length} start incidents=${batch.length}`,
        );
        await processBatchResult(batchIndex, batch, globalIncidentOffset);
        if (batchDelayMs > 0 && batchIndex < batches.length - 1 && !maintenanceRunDeadlineReached()) {
          await sleepSelfCorrectionBackoff(batchDelayMs);
        }
      }

      if (
        maintenanceRunDeadlineReached() &&
        completedBatchIndexes.size > 0 &&
        completedBatchIndexes.size < batches.length
      ) {
        persistBatchState();
        logger.warn?.(
          `memory-hybrid: ${SCAN_TYPE} partial run — maintenance deadline (batches ${completedBatchIndexes.size}/${batches.length})`,
        );
      }

      if (opts.verbose && analysed.length > 0) {
        logger.info?.(
          `memory-hybrid: ${SCAN_TYPE} — LLM returned ${analysed.length} remediation item(s) (before cap/filter)`,
        );
      }
    } catch (e) {
      persistBatchState();
      capturePluginError(e as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:llm-analysis" });
      const isParseFailure = (e as any).isParseFailure === true;
      const batchesCompleted = completedBatchIndexes.size;
      const isPartial = batchesCompleted > 0 && batchesCompleted < batches.length;
      let autoFixed = 0;
      let proposals: string[] = [];
      let toolsSuggestions: string[] | undefined;
      let toolsApplied: number | undefined;
      if (!opts.dryRun && analysed.length > 0) {
        const applied = await applySelfCorrectionRemediations({
          ctx,
          analysed,
          incidents,
          workspaceRoot,
          scCfg,
          opts,
          model,
          modelSource,
          scFallbackModels,
        });
        autoFixed = applied.autoFixed;
        proposals = applied.proposals;
        toolsSuggestions = applied.toolsSuggestions.length > 0 ? applied.toolsSuggestions : undefined;
        toolsApplied = applied.toolsApplied > 0 ? applied.toolsApplied : undefined;
        if (!opts.dryRun && reportPath) {
          const reportLines = buildSelfCorrectionReportLines({
            today,
            incidentsCount: incidents.length,
            analysed,
            autoFixed,
            proposals,
            toolsSuggestions: applied.toolsSuggestions,
            toolsApplied: applied.toolsApplied,
            diagnostics,
            scCfg,
          });
          try {
            atomicWriteFile(reportPath, reportLines.join("\n"));
          } catch (writeErr) {
            logger.warn?.(`memory-hybrid: could not write partial report: ${writeErr}`);
          }
        }
      }
      const status = isPartial
        ? "failed_partial"
        : isParseFailure
          ? "failed_parse"
          : batchesCompleted < batches.length
            ? "failed"
            : undefined;
      if (isPartial) {
        logger.warn?.(
          `memory-hybrid: ${SCAN_TYPE} — partial batch failure: batches_completed=${batchesCompleted}/${batches.length} analysed=${analysed.length}`,
        );
      }
      if (jobRun) {
        jobRun.endPhase("analyze", isPartial ? "failed" : "failed", String(e).slice(0, 200));
      }
      const jobRunId = finishSelfCorrectionJobRun(jobRun, status, { clearCheckpoint: !isPartial });
      return {
        incidentsFound: incidents.length,
        analysed: analysed.length,
        autoFixed,
        proposals,
        reportPath: isPartial && !opts.dryRun ? reportPath : null,
        toolsSuggestions,
        toolsApplied,
        error: String(e),
        retryCount: diagnostics.retries,
        fallbackCount: diagnostics.fallbacks,
        parseFailures: diagnostics.parseFailures,
        unparseableFailures: diagnostics.unparseableFailures,
        batchesStarted,
        batchesCompleted,
        totalBatches: batches.length,
        status,
        jobRunId,
        semanticOutcome: selfCorrectionStatusToJobRunOutcome(status),
      };
    }
    if (incidents.length > 0 && analysed.length === 0) {
      const error = `Self-correction analysis suspect: ${incidents.length} incident(s) found but zero parsed/analysed remediation items.`;
      logger.warn?.(`memory-hybrid: ${SCAN_TYPE} — ${error}`);
      if (jobRun) {
        jobRun.endPhase("analyze", "failed", error);
      }
      removeLegacySelfCorrectionState(stateDir, runFingerprint, SELF_CORRECTION_BATCH_STATE_PREFIX);
      const jobRunId = finishSelfCorrectionJobRun(jobRun, "failed_suspect_zero_parsed", { clearCheckpoint: true });
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
        batchesStarted,
        status: "failed_suspect_zero_parsed",
        jobRunId,
        semanticOutcome: "failed_semantic_empty",
      };
    }
    const applied = await applySelfCorrectionRemediations({
      ctx,
      analysed,
      incidents,
      workspaceRoot,
      scCfg,
      opts,
      model,
      modelSource,
      scFallbackModels,
    });
    const { autoFixed, proposals, toolsSuggestions, toolsApplied } = applied;

    const reportLines = buildSelfCorrectionReportLines({
      today,
      incidentsCount: incidents.length,
      analysed,
      autoFixed,
      proposals,
      toolsSuggestions,
      toolsApplied,
      diagnostics,
      scCfg,
    });
    if (!opts.dryRun) {
      try {
        atomicWriteFile(reportPath, reportLines.join("\n"));
      } catch (e) {
        logger.warn?.(`memory-hybrid: could not write report: ${e}`);
        capturePluginError(e as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:write-report" });
      }
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

    const allBatchesCompleted = completedBatchIndexes.size === batches.length;

    if (!opts.dryRun && !opts.incidents && !opts.extractPath && allBatchesCompleted) {
      const sessionPaths = [...new Set(incidents.map((i) => i.sessionFile).filter(Boolean))];
      const lastSessionTs = sessionPaths.length > 0 ? (getMaxMtime(sessionPaths) ?? Date.now()) : Date.now();
      const sessionsProcessedThisRun =
        extractSessionsScanned > 0
          ? extractSessionsScanned
          : sessionPaths.length > 0
            ? sessionPaths.length
            : 1;
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs, sessionsProcessedThisRun);
    }

    if (jobRun) {
      jobRun.endPhase("analyze", "completed", `analysed=${analysed.length}`);
      jobRun.startPhase("apply");
      jobRun.endPhase("apply", "completed", `autoFixed=${autoFixed}`);
    }
    if (allBatchesCompleted) {
      removeLegacySelfCorrectionState(stateDir, runFingerprint, SELF_CORRECTION_BATCH_STATE_PREFIX);
    }
    const jobRunId = finishSelfCorrectionJobRun(jobRun, "success_analyzed", { clearCheckpoint: allBatchesCompleted });

    return {
      incidentsFound: incidents.length,
      analysed: analysed.length,
      autoFixed,
      proposals,
      reportPath: opts.dryRun ? null : reportPath,
      toolsSuggestions: toolsSuggestions.length > 0 ? toolsSuggestions : undefined,
      toolsApplied: toolsApplied > 0 ? toolsApplied : undefined,
      retryCount: diagnostics.retries,
      fallbackCount: diagnostics.fallbacks,
      parseFailures: diagnostics.parseFailures,
      unparseableFailures: diagnostics.unparseableFailures,
      batchesStarted,
      batchesCompleted: completedBatchIndexes.size,
      totalBatches: batches.length,
      status: "success_analyzed",
      jobRunId,
      semanticOutcome: "success",
    };
  } finally {
    if (!bypassScanCooldown && !opts.dryRun && !opts.incidents && !opts.extractPath) clearScanLock(SCAN_TYPE);
  }
}
