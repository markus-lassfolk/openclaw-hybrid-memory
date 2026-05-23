import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { parseDuration } from "../utils/duration.js";
import { getEnv } from "../utils/env-manager.js";
import { estimateTokens, sanitizeRecallFactText } from "../utils/text.js";
import { readActiveTaskFile } from "./active-task.js";
import { buildActiveTaskContextBundle } from "./active-task-injection.js";
import { capturePluginError } from "./error-reporter.js";
import { readActiveTaskRowsFromFacts } from "./task-ledger-facts.js";

type ContextAuditResult = {
  autoRecall: {
    enabled: boolean;
    budgetTokens: number;
    hotTokens: number;
    injectionFormat: string;
    fixedBlocks: {
      caps: {
        issueMaxTokens: number;
        narrativeMaxTokens: number;
        hotMaxTokens: number;
        procedureMaxTokens: number;
        activeTaskMaxTokens: number;
        staleWarningMaxTokens: number;
      };
      estimatedTokens: {
        issue: number;
        narrative: number;
        hot: number;
        procedures: number;
        activeTasks: number;
        staleWarnings: number;
        total: number;
        remainingForRecall: number;
        wouldExhaustRecall: boolean;
      };
    };
  };
  procedures: { enabled: boolean; tokens: number; lines: number };
  activeTasks: {
    enabled: boolean;
    tokens: number;
    /** Rows in ledger with non-terminal status (before projection). */
    ledgerActiveCount: number;
    /** Rows after projection/sort caps (candidates for injection). */
    filteredActiveCount: number;
    /** Tasks listed in `<active-tasks>` summary. */
    injectedTaskCount: number;
    /** @deprecated Use ledgerActiveCount instead. Kept for backwards compatibility. */
    count: number;
    /** @deprecated Use injectedTaskCount instead. Kept for older machine-readable consumers. */
    injectedCount: number;
    stale: number;
    injectionBudget: number;
  };
  workspaceFiles: { totalTokens: number; files: Array<{ file: string; tokens: number }> };
  totalTokens: number;
  recommendations: string[];
};

const DEFAULT_BOOTSTRAP_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "TOOLS.md",
  "MEMORY.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
];

export async function runContextAudit(opts: {
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  workspaceRoot?: string;
}): Promise<ContextAuditResult> {
  const { cfg, factsDb } = opts;
  const workspaceRoot = opts.workspaceRoot ?? getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");

  const workspaceFiles: Array<{ file: string; tokens: number }> = [];
  for (const file of DEFAULT_BOOTSTRAP_FILES) {
    const fp = isAbsolute(file) ? file : join(workspaceRoot, file);
    if (!existsSync(fp)) continue;
    const content = readFileSync(fp, "utf-8");
    workspaceFiles.push({ file, tokens: estimateTokens(content) });
  }
  const workspaceTokens = workspaceFiles.reduce((sum, f) => sum + f.tokens, 0);

  let activeTasksTokens = 0;
  let staleWarningTokens = 0;
  let ledgerActiveCount = 0;
  let filteredActiveCount = 0;
  let injectedTaskCount = 0;
  let activeTasksStale = 0;
  if (cfg.activeTask.enabled) {
    try {
      const staleMinutes = parseDuration(cfg.activeTask.staleThreshold);
      let activeRows: import("./active-task.js").ActiveTaskEntry[] = [];
      if (cfg.activeTask.ledger === "facts") {
        const { active } = readActiveTaskRowsFromFacts(factsDb, staleMinutes);
        activeRows = active;
      } else {
        const taskFile = await readActiveTaskFile(
          isAbsolute(cfg.activeTask.filePath) ? cfg.activeTask.filePath : join(workspaceRoot, cfg.activeTask.filePath),
          staleMinutes,
        );
        if (taskFile?.active.length) activeRows = taskFile.active;
      }
      const bundle = buildActiveTaskContextBundle({
        ledgerTasks: activeRows,
        injectionBudgetTokens: cfg.activeTask.injectionBudget,
        staleMinutes,
        staleWarningEnabled: cfg.activeTask.staleWarning.enabled,
        projection: cfg.activeTask.projection,
        injectionMaxTasks: cfg.activeTask.injectionMaxTasks,
      });
      activeTasksTokens = bundle.activeTaskTokens;
      staleWarningTokens = bundle.staleWarningTokens;
      ledgerActiveCount = bundle.ledgerActiveCount;
      filteredActiveCount = bundle.filteredActiveCount;
      injectedTaskCount = bundle.injectedTaskCount;
      activeTasksStale = activeRows.filter((t) => t.stale).length;
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "context-audit",
        operation: "active-task",
      });
    }
  }

  let proceduresTokens = 0;
  let proceduresLines = 0;
  if (cfg.procedures.enabled) {
    try {
      const procedures = factsDb.getProceduresForAudit(5);
      const positive = procedures.filter((p) => p.procedureType === "positive");
      const negative = procedures.filter((p) => p.procedureType === "negative");
      const lines: string[] = [];

      if (positive.length > 0) {
        lines.push("Last time this worked:");
        for (const p of positive.slice(0, 3)) {
          try {
            const steps = (JSON.parse(p.recipeJson) as Array<{ tool?: string }>)
              .map((s) => s.tool)
              .filter(Boolean)
              .join(" → ");
            const emoji = p.confidence >= 0.7 ? "✅" : "⚠️";
            const confidence = Math.round(p.confidence * 100);
            lines.push(`- ${emoji} [${confidence}%] ${p.taskPattern.slice(0, 50)}… (${steps})`);
          } catch {
            const emoji = p.confidence >= 0.7 ? "✅" : "⚠️";
            const confidence = Math.round(p.confidence * 100);
            lines.push(`- ${emoji} [${confidence}%] ${p.taskPattern.slice(0, 70)}…`);
          }
        }
      }

      if (negative.length > 0) {
        lines.push("⚠️ Known issue (avoid):");
        for (const n of negative.slice(0, 2)) {
          try {
            const steps = (JSON.parse(n.recipeJson) as Array<{ tool?: string }>)
              .map((s) => s.tool)
              .filter(Boolean)
              .join(" → ");
            const emoji = n.confidence >= 0.7 ? "❌" : "⚠️";
            const confidence = Math.round(n.confidence * 100);
            lines.push(`- ${emoji} [${confidence}%] ${n.taskPattern.slice(0, 50)}… (${steps})`);
          } catch {
            const emoji = n.confidence >= 0.7 ? "❌" : "⚠️";
            const confidence = Math.round(n.confidence * 100);
            lines.push(`- ${emoji} [${confidence}%] ${n.taskPattern.slice(0, 70)}…`);
          }
        }
      }

      if (lines.length > 0) {
        const block = `<relevant-procedures>\n${lines.join("\n")}\n</relevant-procedures>`;
        proceduresTokens = estimateTokens(block);
        proceduresLines = lines.length;
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "context-audit",
        operation: "procedures",
      });
    }
  }

  let hotTokens = 0;
  if (cfg.memoryTiering.enabled && cfg.memoryTiering.hotMaxTokens > 0) {
    try {
      const hotResults = factsDb.getHotFacts(cfg.memoryTiering.hotMaxTokens);
      if (hotResults.length > 0) {
        const hotLines = hotResults
          .map((r) => {
            const text = sanitizeRecallFactText(r.entry.summary || r.entry.text);
            if (!text) return "";
            const clipped = `${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`;
            return `- [hot/${r.entry.category}] ${clipped}`;
          })
          .filter(Boolean);
        if (hotLines.length > 0) {
          const hotBlock = `<hot-memories>\n${hotLines.join("\n")}\n</hot-memories>`;
          hotTokens = estimateTokens(hotBlock);
        }
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "context-audit",
        operation: "hot-memories",
      });
    }
  }

  const autoRecallBudget = cfg.autoRecall.enabled
    ? Math.min(cfg.autoRecall.maxTokens, cfg.retrieval.ambientBudgetTokens)
    : 0;
  const autoRecallHasBudget = cfg.autoRecall.enabled && autoRecallBudget > 0;
  const issueCapTokens = autoRecallHasBudget ? Math.max(80, Math.floor(autoRecallBudget * 0.15)) : 0;
  const narrativeMaxTokens = autoRecallHasBudget
    ? (cfg.autoRecall.narrativeMaxTokens ?? Math.max(100, Math.floor(autoRecallBudget * 0.2)))
    : 0;
  const hotMaxTokens = autoRecallHasBudget
    ? (cfg.autoRecall.hotMaxTokens ?? (hotTokens > 0 ? Math.max(100, Math.floor(autoRecallBudget * 0.25)) : 0))
    : 0;
  const defaultProcedureCap =
    autoRecallHasBudget && proceduresTokens > 0 ? Math.max(100, Math.floor(autoRecallBudget * 0.2)) : 0;
  const procedureMaxTokens = autoRecallHasBudget
    ? (cfg.autoRecall.procedureMaxTokens ??
      (cfg.procedures.enabled ? Math.min(cfg.procedures.maxInjectionTokens, defaultProcedureCap) : 0))
    : 0;
  const activeTaskMaxTokens = autoRecallHasBudget
    ? (cfg.autoRecall.activeTaskMaxTokens ??
      (cfg.activeTask.enabled
        ? Math.min(cfg.activeTask.injectionBudget, Math.max(80, Math.floor(autoRecallBudget * 0.2)))
        : 0))
    : 0;
  const staleWarningMaxTokens = autoRecallHasBudget
    ? (cfg.autoRecall.staleWarningMaxTokens ??
      (cfg.activeTask.enabled && cfg.activeTask.staleWarning.enabled
        ? Math.max(40, Math.floor(autoRecallBudget * 0.08))
        : 0))
    : 0;

  const issueEstimateTokens = cfg.ambient.enabled ? issueCapTokens : 0;
  const narrativeEstimateTokens = narrativeMaxTokens;
  const activeTaskEstimateTokens = Math.min(activeTasksTokens, activeTaskMaxTokens);
  const staleWarningEstimateTokens = Math.min(staleWarningTokens, staleWarningMaxTokens);
  const fixedBlockEstimatedTokens =
    issueEstimateTokens +
    narrativeEstimateTokens +
    Math.min(hotTokens, hotMaxTokens) +
    Math.min(proceduresTokens, procedureMaxTokens) +
    activeTaskEstimateTokens +
    staleWarningEstimateTokens;
  const remainingForRecall = Math.max(0, autoRecallBudget - fixedBlockEstimatedTokens);
  const wouldExhaustRecall = cfg.autoRecall.enabled && autoRecallBudget > 0 && remainingForRecall === 0;

  const totalTokens = autoRecallBudget + hotTokens + proceduresTokens + activeTasksTokens + workspaceTokens;

  const recommendations: string[] = [];
  if (workspaceTokens > 3000) {
    recommendations.push("Trim bootstrap files (AGENTS.md / TOOLS.md / MEMORY.md) to keep total under ~3000 tokens.");
  }
  if (cfg.autoRecall.enabled && autoRecallBudget > 1200) {
    recommendations.push("Lower autoRecall.maxTokens or switch to progressive injection to save context.");
  }
  if (wouldExhaustRecall) {
    recommendations.push(
      "Fixed block caps consume the full recall budget. Lower hot/narrative/procedure/activeTask caps or increase autoRecall.maxTokens.",
    );
  }
  if (cfg.activeTask.enabled && activeTasksTokens > cfg.activeTask.injectionBudget) {
    recommendations.push(
      "Active tasks exceed the injection budget; consider summarizing or lowering activeTask.injectionBudget.",
    );
  }
  if (proceduresTokens > 600) {
    recommendations.push(
      "Procedure injection is sizable; consider pruning procedures or raising the relevance threshold.",
    );
  }
  if (totalTokens > 8000) {
    recommendations.push(
      "Total injected context is high; reduce auto-recall, bootstrap files, or active tasks to avoid compaction.",
    );
  }

  return {
    autoRecall: {
      enabled: cfg.autoRecall.enabled,
      budgetTokens: autoRecallBudget,
      hotTokens,
      injectionFormat: cfg.autoRecall.injectionFormat,
      fixedBlocks: {
        caps: {
          issueMaxTokens: issueCapTokens,
          narrativeMaxTokens,
          hotMaxTokens,
          procedureMaxTokens,
          activeTaskMaxTokens,
          staleWarningMaxTokens,
        },
        estimatedTokens: {
          issue: issueEstimateTokens,
          narrative: narrativeEstimateTokens,
          hot: Math.min(hotTokens, hotMaxTokens),
          procedures: Math.min(proceduresTokens, procedureMaxTokens),
          activeTasks: activeTaskEstimateTokens,
          staleWarnings: staleWarningEstimateTokens,
          total: fixedBlockEstimatedTokens,
          remainingForRecall,
          wouldExhaustRecall,
        },
      },
    },
    procedures: { enabled: cfg.procedures.enabled, tokens: proceduresTokens, lines: proceduresLines },
    activeTasks: {
      enabled: cfg.activeTask.enabled,
      tokens: activeTasksTokens,
      ledgerActiveCount,
      filteredActiveCount,
      injectedTaskCount,
      count: ledgerActiveCount,
      injectedCount: injectedTaskCount,
      stale: activeTasksStale,
      injectionBudget: cfg.activeTask.injectionBudget,
    },
    workspaceFiles: { totalTokens: workspaceTokens, files: workspaceFiles },
    totalTokens,
    recommendations,
  };
}
