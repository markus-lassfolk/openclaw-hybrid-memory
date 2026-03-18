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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { getCronModelConfig, getDefaultCronModel, getLLMModelPreference } from "../config.js";
import type { SelfCorrectionExtractResult, SelfCorrectionRunResult } from "./types.js";
import { chatCompleteWithRetry, distillMaxOutputTokens } from "../services/chat.js";
import { runSelfCorrectionExtract, type CorrectionIncident } from "../services/self-correction-extract.js";
import { capturePluginError } from "../services/error-reporter.js";
import { getCorrectionSignalRegex } from "../utils/language-keywords.js";
import { loadPrompt, fillPrompt } from "../utils/prompt-loader.js";
import { insertRulesUnderSection } from "../services/tools-md-section.js";
import { preFilterSessions } from "../services/session-pre-filter.js";
import { CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import type { HandlerContext } from "./handlers.js";
import {
  gatherSessionFiles,
  acquireScanSlot,
  clearScanLock,
  buildPreFilterConfig,
  inferTargetFile,
} from "./handlers.js";

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
    /** Pre-filtered session file paths. When provided, skips gatherSessionFiles(). */
    filePaths?: string[];
  },
): SelfCorrectionExtractResult {
  const filePaths =
    opts.filePaths ?? gatherSessionFiles({ days: opts.days ?? 3 }).map((f: { path: string; mtime: number }) => f.path);
  if (filePaths.length === 0) {
    return { incidents: [], sessionsScanned: 0 };
  }
  try {
    const result = runSelfCorrectionExtract({
      filePaths,
      correctionRegex: getCorrectionSignalRegex(),
    });
    if (opts.outputPath && result.incidents.length > 0) {
      try {
        mkdirSync(dirname(opts.outputPath), { recursive: true });
        writeFileSync(opts.outputPath, JSON.stringify(result.incidents, null, 2), "utf-8");
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
  },
): Promise<SelfCorrectionRunResult> {
  const { factsDb, vectorDb, embeddings, openai, cfg, logger, proposalsDb } = ctx;
  const SCAN_TYPE = "self-correction-run";

  // Startup guard + concurrency lock (skip if already ran within 23h and not forced)
  // Only apply when no explicit incidents/extractPath provided (i.e. fresh scan)
  if (!opts.full && !opts.dryRun && !opts.incidents && !opts.extractPath) {
    const cursor = factsDb.getScanCursor(SCAN_TYPE);
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip) {
      return { incidentsFound: 0, analysed: 0, autoFixed: 0, proposals: [], reportPath: null, skipped: true };
    }
  }

  try {
    const workspaceRoot = opts.workspace ?? process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
    const scCfg = cfg.selfCorrection ?? DEFAULT_SELF_CORRECTION;
    const reportDir = join(workspaceRoot, "memory", "reports");
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = join(reportDir, `self-correction-${today}.md`);
    let incidents: CorrectionIncident[];
    if (opts.incidents && opts.incidents.length > 0) {
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
      const extractResult = runSelfCorrectionExtractForCli(ctx, { days: 3, filePaths: scFilePaths });
      incidents = extractResult.incidents;
    }
    if (incidents.length === 0) {
      const emptyReport = `# Self-Correction Analysis (${today})\n\nScanned sessions: 3 days.\nIncidents found: 0.\n`;
      try {
        mkdirSync(reportDir, { recursive: true });
        writeFileSync(reportPath, emptyReport, "utf-8");
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
      return { incidentsFound: 0, analysed: 0, autoFixed: 0, proposals: [], reportPath };
    }
    const prompt = fillPrompt(loadPrompt("self-correction-analyze"), {
      incidents_json: JSON.stringify(incidents),
    });
    const heavyPref = getLLMModelPreference(getCronModelConfig(cfg), "heavy");
    const model = opts.model ?? heavyPref[0] ?? getDefaultCronModel(getCronModelConfig(cfg), "heavy");
    const scFallbackModels = opts.model
      ? []
      : heavyPref.length > 1
        ? heavyPref.slice(1)
        : cfg.llm
          ? []
          : (cfg.distill?.fallbackModels ?? []);
    let analysed: Array<{
      category: string;
      severity: string;
      remediationType: string;
      remediationContent: string | { text?: string; entity?: string; key?: string; tags?: string[] };
      repeated?: boolean;
    }> = [];
    const useSpawn = scCfg.analyzeViaSpawn && incidents.length > scCfg.spawnThreshold;
    try {
      let content: string;
      if (useSpawn) {
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
        content = (r.stdout ?? "") + (r.stderr ?? "");
        if (r.status !== 0) throw new Error(`sessions spawn exited ${r.status}: ${content.slice(0, 500)}`);
      } else {
        content = await chatCompleteWithRetry({
          model,
          content: prompt,
          temperature: 0.2,
          maxTokens: distillMaxOutputTokens(model),
          openai,
          fallbackModels: scFallbackModels,
          label: "memory-hybrid: self-correction analyze",
        });
      }
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        analysed = JSON.parse(jsonMatch[0]) as typeof analysed;
      }
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runSelfCorrectionRunForCli:llm-analysis" });
      return {
        incidentsFound: incidents.length,
        analysed: 0,
        autoFixed: 0,
        proposals: [],
        reportPath: null,
        error: String(e),
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
        if (!text || factsDb.hasDuplicate(text)) continue;
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
          const entry = factsDb.store({
            text,
            category: "technical",
            importance: CLI_STORE_IMPORTANCE,
            entity: obj.entity ?? null,
            key: typeof obj.key === "string" ? obj.key : null,
            value: text.slice(0, 200),
            source: "self-correction",
            tags: Array.isArray(obj.tags) ? obj.tags : [],
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
          const rewritten = await chatCompleteWithRetry({
            model,
            content: rewritePrompt,
            temperature: 0.2,
            maxTokens: 16000,
            openai,
            fallbackModels: scFallbackModels,
            label: "memory-hybrid: self-correction rewrite-tools",
          });
          const cleaned = rewritten
            .trim()
            .replace(/^```\w*\n?|```\s*$/g, "")
            .trim();
          if (cleaned.length > 50) {
            writeFileSync(toolsPath, cleaned, "utf-8");
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
      `Analysed: ${analysed.length}. Auto-fixed: ${autoFixed}. Needs review: ${proposals.length}.`,
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
        ? ["## TOOLS.md updated", "", `- ${toolsApplied} rule(s) inserted under section \"${toolsSection}\".`, ""]
        : []),
      ...(proposals.length > 0
        ? ["## Proposed (review before applying)", "", ...proposals.map((p) => `- ${p}`), ""]
        : []),
    ];
    try {
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(reportPath, reportLines.join("\n"), "utf-8");
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
    };
  } finally {
    if (!opts.full && !opts.dryRun && !opts.incidents && !opts.extractPath) clearScanLock(SCAN_TYPE);
  }
}
