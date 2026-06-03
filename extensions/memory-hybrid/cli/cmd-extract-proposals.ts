/** Persona proposal generation CLI (`runGenerateProposalsForCli`). Split from cmd-extract.ts. */
import { getEnv } from "../utils/env-manager.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasAnyScopeFilter } from "../backends/scope-filter-sql.js";
import { resolveReflectionModelAndFallbacks } from "../config.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "../services/adaptive-maintenance-llm.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import { capturePluginError } from "../services/error-reporter.js";
import { runIdentityReflection } from "../services/identity-reflection.js";
import {
  buildPersonaStateInsightsBlock,
  promotePersonaStateFromReflections,
} from "../services/persona-state-promotion.js";
import { getFileSnapshot } from "../utils/file-snapshot.js";
import { stripThinkingWrapperBlocks } from "../utils/llm-json-array.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import type { HandlerContext } from "./handlers.js";
import { capProposalConfidence } from "./proposals.js";

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
  const hasScopeFilter = hasAnyScopeFilter(scopeFilter);
  const allRelevant = factsDb
    .getAll({ scopeFilter })
    .filter(
      (f) =>
        (f.category === "pattern" || f.category === "rule") &&
        !f.supersededAt &&
        (f.expiresAt === null || f.expiresAt > nowSec),
    );
  const hasNonGlobalScopedFacts = allRelevant.some((fact) => fact.scope && fact.scope !== "global");
  if (!hasScopeFilter && hasNonGlobalScopedFacts) {
    const scopeFilterWarning =
      "memory-hybrid: generate-proposals — autoRecall.scopeFilter is not set; all stored facts are included regardless of which agent or user created them. Set autoRecall.scopeFilter (e.g. agentId/userId) to restrict proposals to a specific user/agent and avoid cross-user contamination.";
    if (cfg.personaProposals.requireScopeFilter) {
      throw new Error(scopeFilterWarning);
    }
    ctx.logger.warn?.(scopeFilterWarning);
  }
  const patterns = allRelevant.filter((f) => f.category === "pattern");
  const rules = allRelevant.filter((f) => f.category === "rule");
  const metaPatterns = patterns.filter((f) => f.tags?.includes("meta"));

  let personaStateBlock = "";
  if (ctx.personaStateStore) {
    const personaStateEntries = new Map(
      ctx.personaStateStore.listRecent(12, { scopeFilter }).map((entry) => [entry.stateKey, entry] as const),
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
          { dryRun: opts.dryRun, scopeFilter },
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
  const { defaultModel: model, fallbackModels: resolvedFallbacks } = resolveReflectionModelAndFallbacks(cfg, "heavy");
  const fallbackModels = resolvedFallbacks ?? [];
  const allModels = [model, ...fallbackModels];
  let items:
    | Array<{
        targetFile: string;
        title: string;
        observation: string;
        suggestedChange: string;
        confidence: number;
      }>
    | undefined;
  let lastFailReason = "failure_type=unknown";
  for (let modelIdx = 0; modelIdx < allModels.length; modelIdx++) {
    const tryModel = allModels[modelIdx];
    let rawResponse: string;
    try {
      const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
        model: tryModel,
        modelSource: modelIdx === 0 ? "heavy" : "fallback",
        content: prompt,
        temperature: 0.3,
        maxTokens: 4000,
        openai,
        fallbackModels: [],
        label: "memory-hybrid: generate-proposals",
        feature: CostFeature.generateProposals,
        logger: {
          info: (msg) => ctx.logger.info?.(msg),
          warn: (msg) => ctx.logger.warn?.(msg),
        },
      });
      rawResponse = detail.content;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      lastFailReason = `model=${tryModel} failure_type=llm_call_failed`;
      if (opts.verbose) {
        ctx.logger.warn?.(
          `memory-hybrid: generate-proposals — ${tryModel} LLM call failed: ${errMsg.slice(0, 200)}`,
        );
      }
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "cli",
        operation: "runGenerateProposalsForCli:llm",
      });
      continue;
    }
    try {
      const strippedResponse = stripThinkingWrapperBlocks(rawResponse);
      const firstBracket = strippedResponse.indexOf("[");
      const lastBracket = strippedResponse.lastIndexOf("]");
      const trimmed =
        firstBracket !== -1 && lastBracket !== -1 && lastBracket >= firstBracket
          ? strippedResponse.substring(firstBracket, lastBracket + 1)
          : strippedResponse;
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new SyntaxError("Not an array");
      items = parsed;
      break;
    } catch (_err) {
      const responseSnippet = rawResponse.slice(0, 200);
      lastFailReason = `model=${tryModel} failure_type=invalid_json`;
      if (modelIdx < allModels.length - 1) {
        ctx.logger.warn?.(
          `memory-hybrid: generate-proposals — ${tryModel} returned invalid JSON, retrying with fallback model`,
        );
      } else if (opts.verbose) {
        ctx.logger.warn?.(
          `memory-hybrid: generate-proposals — LLM output was not valid JSON: ${responseSnippet}`,
        );
      }
      continue;
    }
  }
  if (items === undefined) {
    const failureMessage = `memory-hybrid: generate-proposals — all models failed: ${lastFailReason} (models tried: ${allModels.join(", ")})`;
    console.error(failureMessage);
    throw new Error(failureMessage);
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
