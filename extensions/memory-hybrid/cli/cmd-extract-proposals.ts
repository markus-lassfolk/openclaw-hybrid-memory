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
    const detail = await chatCompleteWithRetryDetailed({
      model,
      content: prompt,
      temperature: 0.3,
      maxTokens: 4000,
      openai,
      fallbackModels,
      label: "memory-hybrid: generate-proposals",
      feature: CostFeature.generateProposals,
    });
    rawResponse = detail.content;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `memory-hybrid: generate-proposals LLM call failed (model=${model}, fallbacks=${JSON.stringify(
        fallbackModels,
      )}): ${errMsg}`,
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
        `memory-hybrid: proposal dropped — confidence ${
          confidence < Number(item.confidence)
            ? `capped to ${confidence.toFixed(2)} (below minConf ${minConf})`
            : `below minConf ${minConf}`
        }: ${String(item.title ?? "").slice(0, 80)} -> ${targetFile}`,
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
