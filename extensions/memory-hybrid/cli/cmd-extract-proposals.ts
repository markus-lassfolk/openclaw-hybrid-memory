import { resolveHybridMemVerbose } from "./global-verbose.js";
import { getEnv } from "../utils/env-manager.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasAnyScopeFilter } from "../backends/scope-filter-sql.js";
import { resolveReflectionModelAndFallbacks } from "../config.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "../services/adaptive-maintenance-llm.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import { capturePluginError } from "../services/error-reporter.js";
import { emitPipelinePersonaProposed } from "../services/change-feed-emit.js";
import { scoreIdentityGaps } from "../services/identity-gap-scorer.js";
import { runIdentityReflection } from "../services/identity-reflection.js";
import {
  buildPersonaStateInsightsBlock,
  promotePersonaStateFromReflections,
} from "../services/persona-state-promotion.js";
import { parseStructuredItemsAcceptingEmpty, stripThinkingWrapperBlocks } from "../utils/llm-json-array.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { formatDateUtc } from "../utils/dates.js";
import { createLightJobRun, finishLightJobRun } from "../services/maintenance-job-run/light-job-run-bridge.js";
import type { MaintenanceJobRun } from "../services/maintenance-job-run/job-run.js";
import type { HandlerContext } from "./handlers.js";
import { resolvePipelineProposalTarget } from "./proposals.js";
import { workshopStoresFromHandlerContext } from "../services/unified-proposals.js";

function isSelfCorrectionInsight(f: { source?: string | null; tags?: string[] | null }): boolean {
  return (
    f.source === "self-correction" ||
    f.source === "self-correction-analysis" ||
    (f.tags?.includes("self-correction") ?? false)
  );
}

function buildSemanticEmptyFallbackProposal(
  gapBullets: string[],
  allowedFiles: string[],
): {
  targetFile: string;
  title: string;
  observation: string;
  suggestedChange: string;
  confidence: number;
} | null {
  const uncovered = gapBullets.find((b) => b.startsWith("Uncovered in "));
  if (!uncovered) return null;
  const fileMatch = uncovered.match(/^Uncovered in ([^:]+):/);
  const targetFile = fileMatch?.[1]?.trim() ?? "";
  if (!targetFile || !allowedFiles.includes(targetFile as (typeof allowedFiles)[number])) return null;
  const previewMatch = uncovered.match(/"([^"]+)"/);
  const preview = previewMatch?.[1]?.trim() ?? uncovered.slice(0, 120);
  return {
    targetFile,
    title: "Append uncovered reflection insight",
    observation: `Pre-flight identity gap scorer flagged: ${preview}`,
    suggestedChange: `- ${preview}`,
    confidence: 0.7,
  };
}

function isGenerateProposalItem(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as Record<string, unknown>;
  return typeof candidate.targetFile === "string" && typeof candidate.suggestedChange === "string";
}

export async function runGenerateProposalsForCli(
  ctx: HandlerContext,
  opts: { dryRun: boolean; verbose?: boolean },
  api: { resolvePath: (file: string) => string },
  argv: readonly string[] = process.argv,
): Promise<{ created: number; jobRunId?: string; semanticOutcome?: string }> {
  const verbose = resolveHybridMemVerbose(opts, undefined, argv);
  const { factsDb, proposalsDb, cfg, openai } = ctx;
  if (!cfg.personaProposals.enabled || !proposalsDb) {
    return { created: 0 };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const jobRun: MaintenanceJobRun = createLightJobRun("generate-proposals", `${nowSec}`);
  const finishProposals = (
    created: number,
    params: { semanticEmpty?: boolean; skipped?: boolean; inputsProcessed?: number },
  ) => {
    const finished = finishLightJobRun(jobRun, {
      semanticEmpty: params.semanticEmpty,
      skipped: params.skipped,
      inputsProcessed: params.inputsProcessed ?? (params.skipped ? 0 : 1),
      outputsProduced: created,
      dryRun: opts.dryRun,
    });
    return { created, jobRunId: finished.jobRunId, semanticOutcome: finished.semanticOutcome };
  };
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
  const selfCorrectionInsights = allRelevant.filter(isSelfCorrectionInsight).slice(0, 20);
  const implicitInsights = factsDb
    .getAll({ scopeFilter })
    .filter(
      (f) =>
        (f.source === "implicit-feedback" || f.tags?.includes("implicit-feedback")) &&
        !f.supersededAt &&
        (f.expiresAt === null || f.expiresAt > nowSec),
    )
    .slice(0, 15);

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
            verbose,
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
        if (verbose && promotion.candidatesFound > 0) {
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
  if (selfCorrectionInsights.length) {
    insights.push(
      `Self-correction lessons:\n${selfCorrectionInsights.map((f) => `- ${f.text.slice(0, 300)}`).join("\n")}`,
    );
  }
  if (implicitInsights.length) {
    insights.push(`Implicit feedback lessons:\n${implicitInsights.map((f) => `- ${f.text.slice(0, 300)}`).join("\n")}`);
  }
  if (personaStateBlock) {
    insights.push(`Durable persona state:\n${personaStateBlock}`);
  }
  if (insights.length === 0) {
    if (verbose) ctx.logger.info?.("memory-hybrid: generate-proposals — no patterns/rules/meta in memory; skipping.");
    return finishProposals(0, { skipped: true });
  }
  const insightsBlock = insights.join("\n\n");
  const allowedFiles = cfg.personaProposals.allowedFiles;
  const workspace = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
  const gapInsights = [...patterns, ...rules, ...metaPatterns, ...selfCorrectionInsights, ...implicitInsights];
  const identityGapResult = scoreIdentityGaps(gapInsights, workspace);
  const identityGapsBlock = identityGapResult.bullets.join("\n");
  const pendingProposals = proposalsDb.list({ status: "pending" });
  const pendingProposalsBlock =
    pendingProposals.length > 0
      ? pendingProposals
          .slice(0, 20)
          .map((p) => `- ${p.title} -> ${p.targetFile} (pending since ${formatDateUtc(p.createdAt)})`)
          .join("\n")
      : "(none)";
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
  if (verbose) {
    ctx.logger.info?.(
      `memory-hybrid: generate-proposals — identity_gap_score=${identityGapResult.score.toFixed(2)} pending=${pendingProposals.length}`,
    );
  }
  const prompt = fillPrompt(loadPrompt("generate-proposals"), {
    allowed_files: allowedFiles.join(", "),
    min_confidence: String(cfg.personaProposals.minConfidence),
    insights: insightsBlock,
    identity_files: identityFilesBlock,
    identity_gaps: identityGapsBlock,
    pending_proposals: pendingProposalsBlock,
  });
  const { defaultModel: model, fallbackModels: resolvedFallbacks } = resolveReflectionModelAndFallbacks(
    cfg,
    "maintenance",
  );
  const fallbackModels = resolvedFallbacks ?? [];
  const allModels = [model, ...fallbackModels];
  ctx.logger.info?.(
    `memory-hybrid: generate-proposals fallback chain = [${fallbackModels.length > 0 ? fallbackModels.join(", ") : ""}]`,
  );
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
        modelSource: modelIdx === 0 ? "maintenance" : "fallback",
        content: prompt,
        temperature: 0.3,
        maxTokens: 4000,
        openai,
        fallbackModels: [],
        label: "memory-hybrid: generate-proposals",
        feature: CostFeature.generateProposals,
        thinkingMode: "disabled",
        logger: {
          info: (msg) => ctx.logger.info?.(msg),
          warn: (msg) => ctx.logger.warn?.(msg),
        },
      });
      rawResponse = detail.content;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      lastFailReason = `model=${tryModel} failure_type=llm_call_failed`;
      if (verbose) {
        ctx.logger.warn?.(`memory-hybrid: generate-proposals — ${tryModel} LLM call failed: ${errMsg.slice(0, 200)}`);
      }
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "cli",
        operation: "runGenerateProposalsForCli:llm",
      });
      continue;
    }
    try {
      const parsed = parseStructuredItemsAcceptingEmpty(rawResponse, isGenerateProposalItem);
      if (parsed === null) throw new SyntaxError("No valid proposal items parsed");
      items = parsed as typeof items;
      break;
    } catch (_err) {
      const responseSnippet = rawResponse.slice(0, 200);
      lastFailReason = `model=${tryModel} failure_type=invalid_json`;
      if (modelIdx < allModels.length - 1) {
        ctx.logger.warn?.(
          `memory-hybrid: generate-proposals — ${tryModel} returned invalid JSON, retrying with fallback model`,
        );
      } else if (verbose) {
        ctx.logger.warn?.(`memory-hybrid: generate-proposals — LLM output was not valid JSON: ${responseSnippet}`);
      }
      continue;
    }
  }
  if (items === undefined) {
    const failureMessage = `memory-hybrid: generate-proposals — all models failed: ${lastFailReason} (models tried: ${allModels.join(", ")})`;
    console.error(`${failureMessage} parse_success=false`);
    finishLightJobRun(jobRun, {
      skipped: false,
      semanticEmpty: true,
      inputsProcessed: insights.length,
      outputsProduced: 0,
      dryRun: opts.dryRun,
    });
    throw new Error(failureMessage);
  }
  if (items.length === 0 && insights.length > 0) {
    // One retry with explicit nudge when model returns [] despite rich insight input.
    const retryPrompt = `${prompt}\n\nIf any gap exists between the reflection data and identity files, return at least one well-supported proposal. Do not return an empty array when insights are present.`;
    try {
      const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
        model: allModels[0],
        modelSource: "maintenance",
        content: retryPrompt,
        temperature: 0.35,
        maxTokens: 4000,
        openai,
        fallbackModels: fallbackModels.slice(0, 1),
        label: "memory-hybrid: generate-proposals-retry",
        feature: CostFeature.generateProposals,
        thinkingMode: "disabled",
        logger: {
          info: (msg) => ctx.logger.info?.(msg),
          warn: (msg) => ctx.logger.warn?.(msg),
        },
      });
      const parsed = parseStructuredItemsAcceptingEmpty(detail.content, isGenerateProposalItem);
      if (parsed && parsed.length > 0) {
        items = parsed as typeof items;
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "cli",
        operation: "runGenerateProposalsForCli:semantic-empty-retry",
      });
    }
  }
  if (items.length === 0 && insights.length > 0) {
    if (identityGapResult.score >= 0.25) {
      const fallback = buildSemanticEmptyFallbackProposal(identityGapResult.bullets, allowedFiles);
      if (fallback) {
        ctx.logger.warn?.(
          `memory-hybrid: generate-proposals semantic_empty_with_gaps=true identity_gap_score=${identityGapResult.score.toFixed(2)} — using deterministic fallback proposal`,
        );
        items = [fallback];
      }
    }
  }
  if (items.length === 0 && insights.length > 0) {
    const failureMessage =
      "memory-hybrid: generate-proposals semantic_empty: had insight input but parsed zero proposal items";
    ctx.logger.warn?.(
      `${failureMessage} identity_gap_score=${identityGapResult.score.toFixed(2)} parse_success=false created=0 — returning degraded empty result`,
    );
    proposalsDb.recordRun({
      runAt: nowSec,
      insightsCount: insights.length,
      parsedCount: 0,
      createdCount: 0,
      semanticEmpty: true,
      identityGapScore: identityGapResult.score,
      model: allModels[0] ?? null,
      zeroReason: "semantic_empty",
    });
    return finishProposals(0, { semanticEmpty: true, inputsProcessed: insights.length });
  }
  const weekDays = 7;
  const separateSCQuota = cfg.personaProposals.separateSelfCorrectionQuota !== false;
  const recentCount = proposalsDb.countRecentProposals(weekDays, {
    excludeSelfCorrection: separateSCQuota,
  });
  const limit = cfg.personaProposals.maxProposalsPerWeek;
  if (recentCount >= limit) {
    ctx.logger.warn?.(
      `memory-hybrid: generate-proposals weekly cap reached (${recentCount}/${limit} in last ${weekDays}d${separateSCQuota ? ", excluding self-correction" : ""}); skipping creation`,
    );
  }
  const minConf = cfg.personaProposals.minConfidence;
  const evidenceSessions = Array.from(
    { length: Math.max(1, cfg.personaProposals.minSessionEvidence) },
    () => "reflection-pipeline",
  );
  const workshopStores = workshopStoresFromHandlerContext(ctx);
  let created = 0;
  for (const item of items) {
    if (recentCount + created >= limit) {
      if (created === 0) {
        ctx.logger.warn?.(
          `memory-hybrid: generate-proposals weekly cap reached (${recentCount}/${limit}); parsed ${items.length} item(s) but created 0`,
        );
      }
      break;
    }
    const targetFile = String(item.targetFile ?? "").trim();
    const suggestedChange = String(item.suggestedChange ?? "").slice(0, 50000);
    if (!suggestedChange.trim()) continue;
    const rawConfidence = Number(item.confidence);
    if (!Number.isFinite(rawConfidence)) continue;
    const resolved = resolvePipelineProposalTarget({
      targetFile,
      suggestedChange,
      allowedFiles,
      workspaceRoot: workspace,
      confidence: rawConfidence,
      proposalTTLDays: cfg.personaProposals.proposalTTLDays,
      minConfidence: minConf,
      nowSec,
      proposalsDb,
      workshopStores,
    });
    if (!resolved) {
      if (verbose) {
        ctx.logger.info?.(
          `memory-hybrid: proposal dropped — failed allowlist/confidence/safety gates: ${String(item.title ?? "").slice(0, 80)} -> ${targetFile}`,
        );
      }
      continue;
    }
    const title = String(item.title ?? "Update from reflection").slice(0, 256);
    const observation = String(item.observation ?? "").slice(0, 2000);
    if (opts.dryRun) {
      if (verbose) ctx.logger.info?.(`memory-hybrid: [dry-run] would create proposal: ${title} -> ${targetFile}`);
      created++;
      continue;
    }
    try {
      const proposal = proposalsDb.create({
        targetFile: resolved.targetFile,
        title,
        observation,
        suggestedChange,
        confidence: resolved.confidence,
        evidenceSessions,
        expiresAt: resolved.expiresAt,
        targetMtimeMs: resolved.targetMtimeMs,
        targetHash: resolved.targetHash,
      });
      emitPipelinePersonaProposed(ctx.changeFeed, cfg, proposal, observation);
      created++;
      if (verbose) ctx.logger.info?.(`memory-hybrid: proposal created: ${title} -> ${targetFile}`);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "cli",
        operation: "runGenerateProposalsForCli:create",
      });
    }
  }
  proposalsDb.recordRun({
    runAt: nowSec,
    insightsCount: insights.length,
    parsedCount: items.length,
    createdCount: created,
    semanticEmpty: created === 0 && items.length === 0,
    identityGapScore: identityGapResult.score,
    model: allModels[0] ?? null,
    zeroReason: created === 0 ? (items.length === 0 ? "semantic_empty" : "filtered_or_capped") : null,
  });
  if (verbose) {
    ctx.logger.info?.(
      `memory-hybrid: generate-proposals — identity_gap_score=${identityGapResult.score.toFixed(2)} created=${created}`,
    );
  }
  return finishProposals(created, {
    semanticEmpty: created === 0 && items.length === 0,
    inputsProcessed: insights.length,
  });
}
