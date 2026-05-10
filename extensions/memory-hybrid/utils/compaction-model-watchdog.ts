import { isHeavyModel } from "./model-tier.js";

export const DEFAULT_COMPACTION_MODEL = "minimax/MiniMax-M2.7";

export type CompactionFallbackPolicy = "default-mini" | "inherit-agent-primary";

export type CompactionModelSelection = {
  model: string;
  provider: string;
  reason: string;
  inherited: boolean;
};

export type CompactionWatchdogContext = "verify" | "before_compaction" | "after_compaction";

function readAgentMain(root: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const agents = root?.agents as Record<string, unknown> | undefined;
  const list = agents?.list;
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (row.id === "main") return row;
  }
  return undefined;
}

function readAgentsDefaults(root: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return (root?.agents as Record<string, unknown> | undefined)?.defaults as Record<string, unknown> | undefined;
}

function readCompactionModelFromAgentBlock(agentBlock: Record<string, unknown> | undefined): string | undefined {
  const compaction = agentBlock?.compaction as Record<string, unknown> | undefined;
  const model = compaction?.model;
  if (typeof model !== "string") return undefined;
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPrimaryModelFromAgentBlock(agentBlock: Record<string, unknown> | undefined): string | undefined {
  const model = agentBlock?.model as Record<string, unknown> | undefined;
  const primary = model?.primary;
  if (typeof primary !== "string") return undefined;
  const trimmed = primary.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function inferCompactionProvider(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return "unknown";
  if (trimmed.includes("/")) return (trimmed.split("/")[0] ?? "unknown").trim().toLowerCase() || "unknown";
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("minimax-")) return "minimax";
  if (lower.startsWith("gemini-")) return "google";
  if (lower.startsWith("claude-")) return "anthropic";
  if (lower.startsWith("gpt-") || /^o[0-9]/.test(lower)) return "openai";
  return "unknown";
}

export function resolveCompactionModelSelection(
  root: Record<string, unknown> | undefined,
  opts?: { fallbackPolicy?: CompactionFallbackPolicy; defaultModel?: string },
): CompactionModelSelection {
  const fallbackPolicy = opts?.fallbackPolicy ?? "default-mini";
  const defaultModel = opts?.defaultModel?.trim() || DEFAULT_COMPACTION_MODEL;
  const mainAgent = readAgentMain(root);
  const defaults = readAgentsDefaults(root);

  const mainCompaction = readCompactionModelFromAgentBlock(mainAgent);
  if (mainCompaction) {
    return {
      model: mainCompaction,
      provider: inferCompactionProvider(mainCompaction),
      reason: "agents.list[id=main].compaction.model explicitly set",
      inherited: false,
    };
  }

  const defaultsCompaction = readCompactionModelFromAgentBlock(defaults);
  if (defaultsCompaction) {
    return {
      model: defaultsCompaction,
      provider: inferCompactionProvider(defaultsCompaction),
      reason: "agents.defaults.compaction.model explicitly set",
      inherited: false,
    };
  }

  if (fallbackPolicy === "inherit-agent-primary") {
    const mainPrimary = readPrimaryModelFromAgentBlock(mainAgent);
    if (mainPrimary) {
      return {
        model: mainPrimary,
        provider: inferCompactionProvider(mainPrimary),
        reason: "inherited from agents.list[id=main].model.primary (compaction model unset)",
        inherited: true,
      };
    }
    const defaultsPrimary = readPrimaryModelFromAgentBlock(defaults);
    if (defaultsPrimary) {
      return {
        model: defaultsPrimary,
        provider: inferCompactionProvider(defaultsPrimary),
        reason: "inherited from agents.defaults.model.primary (compaction model unset)",
        inherited: true,
      };
    }
  }

  return {
    model: defaultModel,
    provider: inferCompactionProvider(defaultModel),
    reason: "default mini compaction model (compaction model unset)",
    inherited: false,
  };
}

function isExplicitMiniOrNanoLikeModel(model: string): boolean {
  const lower = (model.split("/").pop() ?? model).toLowerCase();
  return /\bmini\b|\bnano\b|\blite\b|\bhaiku\b/.test(lower);
}

function isMiniMaxM27(model: string): boolean {
  const lower = (model.split("/").pop() ?? model).toLowerCase();
  return /minimax[-_]?m2\.7/.test(lower);
}

/**
 * Cost watchdog classification for compaction model safety.
 * We intentionally do not flag MiniMax M2.7 and mini/nano models.
 */
export function isCompactionModelTooStrong(model: string): boolean {
  if (!model.trim()) return false;
  const provider = inferCompactionProvider(model);
  if (provider === "ollama") return false;
  if (isMiniMaxM27(model)) return false;
  if (isExplicitMiniOrNanoLikeModel(model)) return false;
  return isHeavyModel(model);
}

export function buildCompactionModelWatchdogWarning(
  selection: CompactionModelSelection,
  opts?: { context?: CompactionWatchdogContext; recommendedModel?: string },
): string | null {
  if (!isCompactionModelTooStrong(selection.model)) return null;
  const recommendedModel = opts?.recommendedModel?.trim() || DEFAULT_COMPACTION_MODEL;
  const contextPrefix = opts?.context ? `${opts.context}: ` : "";
  return `${contextPrefix}compaction routing uses a stronger-than-mini model (provider=${selection.provider}, model=${selection.model}, reason=${selection.reason}). Set agents.defaults.compaction.model (or agents.list[id=main].compaction.model) to a mini/nano model such as ${recommendedModel}.`;
}
