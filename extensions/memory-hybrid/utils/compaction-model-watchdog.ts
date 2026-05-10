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
export type CompactionModelStrength = {
  tooStrong: boolean;
  reason: string;
  provider: string;
  model: string;
};

export type CompactionHookModelMetadata = {
  model: string;
  provider: string;
  source: string;
};

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

function readPathValue(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
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

function isExplicitMiniOrNanoModel(model: string): boolean {
  const lower = (model.split("/").pop() ?? model).toLowerCase();
  return /\bmini\b|\bnano\b/.test(lower);
}

function isMiniMaxM27(model: string): boolean {
  const lower = (model.split("/").pop() ?? model).toLowerCase();
  return /minimax[-_]?m2\.7(?:[-_]?high[-_]?speed)?/.test(lower);
}

function isMiniMaxFamilyModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("minimax");
}

function matchesHighTierCompactionFamily(model: string): string | null {
  const lower = (model.split("/").pop() ?? model).toLowerCase();

  // Explicitly requested high-tier families.
  if (/\bgpt-5\b|\bgpt-5\.\d+\b/.test(lower)) return "GPT-5 class model";
  if (/\bgpt-5\.4-pro\b/.test(lower)) return "gpt-5.4-pro high-tier model";
  if (/\bpro\b|\bfull\b|high[-_]?tier|\bheavy\b|\bultra\b|\blarge\b/.test(lower)) {
    return "pro/full/high-tier model keyword match";
  }
  return null;
}

function parseProviderAndModelFromText(raw: string): { provider?: string; model?: string } | null {
  const modelMatch = raw.match(/\bmodel\s*[=:]\s*([a-z0-9._:/-]+)/i);
  if (!modelMatch?.[1]) return null;
  const model = modelMatch[1].trim();
  if (!model) return null;
  const providerMatch = raw.match(/\bprovider\s*[=:]\s*([a-z0-9._-]+)/i);
  const provider = providerMatch?.[1]?.trim();
  return { provider, model };
}

function extractCompactionModelMetadataFromSource(
  sourceObj: unknown,
  sourceName: string,
): CompactionHookModelMetadata | null {
  const candidatePaths: Array<{ modelPath: string[]; providerPath?: string[] }> = [
    { modelPath: ["compaction", "model"], providerPath: ["compaction", "provider"] },
    { modelPath: ["metadata", "compaction", "model"], providerPath: ["metadata", "compaction", "provider"] },
    { modelPath: ["context", "compaction", "model"], providerPath: ["context", "compaction", "provider"] },
    { modelPath: ["payload", "compaction", "model"], providerPath: ["payload", "compaction", "provider"] },
    { modelPath: ["logMetadata", "compaction", "model"], providerPath: ["logMetadata", "compaction", "provider"] },
    { modelPath: ["resolvedCompactionModel"], providerPath: ["resolvedCompactionProvider"] },
    { modelPath: ["selectedCompactionModel"], providerPath: ["selectedCompactionProvider"] },
    { modelPath: ["compactionModel"], providerPath: ["compactionProvider"] },
    { modelPath: ["compaction_model"], providerPath: ["compaction_provider"] },
    { modelPath: ["model"], providerPath: ["provider"] },
  ];

  for (const candidate of candidatePaths) {
    const model = readString(readPathValue(sourceObj, candidate.modelPath));
    if (!model) continue;
    const provider =
      readString(candidate.providerPath ? readPathValue(sourceObj, candidate.providerPath) : undefined) ??
      inferCompactionProvider(model);
    return {
      model,
      provider,
      source: `${sourceName}.${candidate.modelPath.join(".")}`,
    };
  }

  const textPaths: string[][] = [["metadata"], ["logMetadata"], ["context"], ["details"]];
  for (const textPath of textPaths) {
    const raw = readString(readPathValue(sourceObj, textPath));
    if (!raw) continue;
    const parsed = parseProviderAndModelFromText(raw);
    if (!parsed?.model) continue;
    return {
      model: parsed.model,
      provider: (parsed.provider ?? inferCompactionProvider(parsed.model)).toLowerCase(),
      source: `${sourceName}.${textPath.join(".")} (text)`,
    };
  }

  return null;
}

/**
 * Best-effort extraction of compaction provider/model from hook payloads.
 * Returns null when runtime does not expose compaction model metadata.
 */
export function resolveCompactionHookModelMetadata(
  event: unknown,
  hookCtx?: unknown,
): CompactionHookModelMetadata | null {
  const eventCandidate = extractCompactionModelMetadataFromSource(event, "event");
  if (eventCandidate) return eventCandidate;
  const hookCandidate = extractCompactionModelMetadataFromSource(hookCtx, "hookCtx");
  if (hookCandidate) return hookCandidate;
  return null;
}

/**
 * Explain whether a compaction model is cost-safe. Policy:
 * - allow MiniMax M2.7 / M2.7-highspeed
 * - allow explicit mini/nano
 * - allow local ollama models
 * - flag high-tier families and unknown non-mini/non-nano/non-MiniMax models
 */
export function classifyCompactionModelStrength(model: string): CompactionModelStrength {
  const normalizedModel = model.trim();
  const lowerTail = (normalizedModel.split("/").pop() ?? normalizedModel).toLowerCase();
  const provider = inferCompactionProvider(normalizedModel);

  if (!normalizedModel) {
    return {
      tooStrong: false,
      reason: "model metadata unavailable",
      provider,
      model: normalizedModel,
    };
  }
  if (provider === "ollama") {
    return {
      tooStrong: false,
      reason: "local ollama model (no remote LLM cost)",
      provider,
      model: normalizedModel,
    };
  }
  // Explicit denylist families from incident request.
  if (/\bo3(?:[-_a-z0-9.]*)\b/.test(lowerTail)) {
    return {
      tooStrong: true,
      reason: "o3 class model",
      provider,
      model: normalizedModel,
    };
  }
  if (/\bsonnet\b|\bopus\b|\bclaude\b/.test(lowerTail)) {
    return {
      tooStrong: true,
      reason: "Claude Sonnet/Opus class model",
      provider,
      model: normalizedModel,
    };
  }
  if (isMiniMaxM27(normalizedModel)) {
    return {
      tooStrong: false,
      reason: "MiniMax M2.7 allowlist",
      provider,
      model: normalizedModel,
    };
  }
  if (isExplicitMiniOrNanoModel(normalizedModel)) {
    return {
      tooStrong: false,
      reason: "mini/nano allowlist",
      provider,
      model: normalizedModel,
    };
  }

  const explicitHighTier = matchesHighTierCompactionFamily(normalizedModel);
  if (explicitHighTier) {
    return {
      tooStrong: true,
      reason: explicitHighTier,
      provider,
      model: normalizedModel,
    };
  }

  if (isHeavyModel(normalizedModel)) {
    return {
      tooStrong: true,
      reason: "heavy-tier model classification",
      provider,
      model: normalizedModel,
    };
  }

  if (!isMiniMaxFamilyModel(normalizedModel)) {
    return {
      tooStrong: true,
      reason: "unknown non-mini/non-nano/non-MiniMax model",
      provider,
      model: normalizedModel,
    };
  }

  return {
    tooStrong: false,
    reason: "MiniMax provider allowlist",
    provider,
    model: normalizedModel,
  };
}

/**
 * Builds a user-visible watchdog warning string when a compaction model is too strong.
 */
export function buildCompactionWatchdogAlert(opts: {
  stage: "before_compaction" | "after_compaction" | "verify";
  model: string;
  provider?: string;
  source?: string;
}): string | null {
  const assessment = classifyCompactionModelStrength(opts.model);
  if (!assessment.tooStrong) return null;
  const provider = opts.provider?.trim() || assessment.provider;
  const sourcePart = opts.source ? `, source=${opts.source}` : "";
  return `memory-hybrid: compaction model watchdog alert (${opts.stage}) — provider=${provider}, model=${assessment.model}, reason=${assessment.reason}${sourcePart}. Prefer mini/nano compaction routing (recommended default: ${DEFAULT_COMPACTION_MODEL}).`;
}

/**
 * Cost watchdog classification for compaction model safety.
 * Treat only explicit mini-safe allowlist models as safe:
 * - minimax/* (current plugin default family)
 * - ollama/* (local/offline)
 * - any explicit *mini* or *nano* model name
 *
 * Everything else is treated as stronger-than-mini to match warning wording.
 */
export function isCompactionModelTooStrong(model: string): boolean {
  return classifyCompactionModelStrength(model).tooStrong;
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
