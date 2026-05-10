import { isHeavyModel } from "./model-tier.js";

export const DEFAULT_COMPACTION_MODEL = "minimax/MiniMax-M2.7";

export type CompactionFallbackPolicy = "default-mini" | "inherit-agent-primary" | "inherit-defaults-primary";

export type CompactionModelSelection = {
  model: string;
  provider: string;
  reason: string;
  inherited: boolean;
  unsupportedPerAgentCompactionPaths: string[];
  /**
   * When using inherit-* fallback policy, config does not set compaction.model or defaults primary;
   * OpenClaw may compact with the active session chat model (not derivable from file config).
   */
  routingUnknownFromConfig?: boolean;
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

export type CompactionHookIdentity = {
  agentId?: string;
  sessionId?: string;
  source: string;
};

function readAgentList(root: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const agents = root?.agents as Record<string, unknown> | undefined;
  const list = agents?.list;
  if (!Array.isArray(list)) return [];
  const entries: Record<string, unknown>[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    entries.push(entry as Record<string, unknown>);
  }
  return entries;
}

function collectUnsupportedPerAgentCompactionPaths(root: Record<string, unknown> | undefined): string[] {
  const paths: string[] = [];
  const list = readAgentList(root);
  for (let idx = 0; idx < list.length; idx += 1) {
    const entry = list[idx];
    const model = readCompactionModelFromAgentBlock(entry);
    if (!model) continue;
    const rawId = entry.id;
    const id = typeof rawId === "string" && rawId.trim().length > 0 ? rawId.trim() : `index=${String(idx)}`;
    paths.push(`agents.list[id=${id}].compaction.model`);
  }
  return paths;
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
  const defaults = readAgentsDefaults(root);
  const unsupportedPerAgentCompactionPaths = collectUnsupportedPerAgentCompactionPaths(root);

  const defaultsCompaction = readCompactionModelFromAgentBlock(defaults);
  if (defaultsCompaction) {
    return {
      model: defaultsCompaction,
      provider: inferCompactionProvider(defaultsCompaction),
      reason: "agents.defaults.compaction.model explicitly set",
      inherited: false,
      unsupportedPerAgentCompactionPaths,
    };
  }

  if (fallbackPolicy === "inherit-agent-primary" || fallbackPolicy === "inherit-defaults-primary") {
    const defaultsPrimary = readPrimaryModelFromAgentBlock(defaults);
    if (defaultsPrimary) {
      return {
        model: defaultsPrimary,
        provider: inferCompactionProvider(defaultsPrimary),
        reason: "inherited from agents.defaults.model.primary (compaction model unset)",
        inherited: true,
        unsupportedPerAgentCompactionPaths,
      };
    }
    return {
      model: "",
      provider: "unknown",
      reason:
        "agents.defaults.compaction.model and agents.defaults.model.primary unset; OpenClaw compaction may follow the active session chat model",
      inherited: false,
      unsupportedPerAgentCompactionPaths,
      routingUnknownFromConfig: true,
    };
  }

  return {
    model: defaultModel,
    provider: inferCompactionProvider(defaultModel),
    reason: "default mini compaction model (compaction model unset)",
    inherited: false,
    unsupportedPerAgentCompactionPaths,
  };
}

function extractCompactionHookIdentityFromSource(
  sourceObj: unknown,
  sourceName: string,
): CompactionHookIdentity | null {
  const agentPaths: string[][] = [
    ["agentId"],
    ["agent", "id"],
    ["context", "agentId"],
    ["metadata", "agentId"],
    ["metadata", "agent", "id"],
    ["payload", "agentId"],
    ["session", "agentId"],
    ["ctx", "agentId"],
  ];
  const sessionPaths: string[][] = [
    ["sessionId"],
    ["session", "id"],
    ["context", "sessionId"],
    ["metadata", "sessionId"],
    ["payload", "sessionId"],
    ["ctx", "sessionId"],
  ];
  let agentId: string | undefined;
  let sessionId: string | undefined;
  for (const path of agentPaths) {
    agentId = readString(readPathValue(sourceObj, path));
    if (agentId) break;
  }
  for (const path of sessionPaths) {
    sessionId = readString(readPathValue(sourceObj, path));
    if (sessionId) break;
  }
  if (!agentId && !sessionId) return null;
  return { agentId, sessionId, source: sourceName };
}

/**
 * Best-effort extraction of hook identity fields used to contextualize fallback watchdog warnings.
 * Returns null when neither agent nor session metadata is available.
 */
export function resolveCompactionHookIdentity(
  event: unknown,
  hookCtx?: unknown,
  apiContext?: unknown,
): CompactionHookIdentity | null {
  const candidates = [
    extractCompactionHookIdentityFromSource(event, "event"),
    extractCompactionHookIdentityFromSource(hookCtx, "hookCtx"),
    extractCompactionHookIdentityFromSource(apiContext, "api.context"),
  ].filter(Boolean) as CompactionHookIdentity[];
  if (candidates.length === 0) return null;

  const merged: CompactionHookIdentity = {
    source: candidates.map((c) => c.source).join("+"),
  };
  for (const candidate of candidates) {
    if (!merged.agentId && candidate.agentId) merged.agentId = candidate.agentId;
    if (!merged.sessionId && candidate.sessionId) merged.sessionId = candidate.sessionId;
  }
  return merged;
}

export function describeCompactionFallbackScope(identity: CompactionHookIdentity | null | undefined): string {
  const agentId = identity?.agentId?.trim() || "unknown";
  const sessionId = identity?.sessionId?.trim() || "unknown";
  const source = identity?.source?.trim() || "unavailable";
  const scope =
    agentId === "unknown"
      ? "unknown agent context; fallback uses global defaults only"
      : agentId === "main"
        ? "main agent context; fallback uses global defaults only"
        : `non-main agent context (${agentId}); fallback uses global defaults only`;
  return `agent=${agentId}, session=${sessionId}, source=${source}; ${scope}`;
}

function isExplicitMiniOrNanoModel(model: string): boolean {
  const lower = (model.split("/").pop() ?? model).toLowerCase();
  return /\bmini\b|\bnano\b|\blite\b|\bhaiku\b/.test(lower);
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

  // Check for gpt-5.4-pro first (most specific)
  if (/\bgpt-5\.4-pro\b/.test(lower)) return "gpt-5.4-pro high-tier model";
  // Then check for broader GPT-5 class models
  if (/\bgpt-5\b|\bgpt-5\.\d+\b/.test(lower)) return "GPT-5 class model";
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
  // Exclude o3-mini and o3-nano (allowlisted as legitimate cheap models)
  if (/\bo3\b/i.test(lowerTail) && !/o3-mini|o3-nano/i.test(lowerTail)) {
    return {
      tooStrong: true,
      reason: "o3 class model",
      provider,
      model: normalizedModel,
    };
  }
  if (/\bsonnet\b|\bopus\b/.test(lowerTail)) {
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
  if (selection.routingUnknownFromConfig) return null;
  if (!isCompactionModelTooStrong(selection.model)) return null;
  const recommendedModel = opts?.recommendedModel?.trim() || DEFAULT_COMPACTION_MODEL;
  const contextPrefix = opts?.context ? `${opts.context}: ` : "";
  return `${contextPrefix}compaction routing uses a stronger-than-mini model (provider=${selection.provider}, model=${selection.model}, reason=${selection.reason}). Set agents.defaults.compaction.model to a mini/nano model such as ${recommendedModel}.`;
}

export function buildUnsupportedPerAgentCompactionWarning(
  selection: CompactionModelSelection,
  opts?: { context?: CompactionWatchdogContext },
): string | null {
  if (selection.unsupportedPerAgentCompactionPaths.length === 0) return null;
  const contextPrefix = opts?.context ? `${opts.context}: ` : "";
  const paths = selection.unsupportedPerAgentCompactionPaths.slice(0, 3).join(", ");
  const extraCount = selection.unsupportedPerAgentCompactionPaths.length - 3;
  const moreSuffix = extraCount > 0 ? ` (+${extraCount} more)` : "";
  return `${contextPrefix}unsupported per-agent compaction key(s) detected (${paths}${moreSuffix}). OpenClaw core currently resolves compaction from agents.defaults.compaction.model only; move compaction overrides to agents.defaults.compaction.model.`;
}
