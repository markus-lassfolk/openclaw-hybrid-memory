import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type AdaptiveFailureKind = "timeout" | "rate_limit" | "quota" | "context_length" | "other";

export type AdaptiveModelLimitEntryV1 = {
  safeBatchTokenLimit: number;
  safeMaxOutputTokens: number;
  updatedAtMs: number;
  lastSuccessAtMs?: number;
  lastFailureAtMs?: number;
  lastFailureKind?: AdaptiveFailureKind;
  consecutiveFailures?: number;
};

export type AdaptiveModelLimitsStateV1 = {
  version: 1;
  models: Record<string, AdaptiveModelLimitEntryV1>;
};

export const ADAPTIVE_MODEL_LIMITS_VERSION = 1 as const;

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function defaultState(): AdaptiveModelLimitsStateV1 {
  return { version: ADAPTIVE_MODEL_LIMITS_VERSION, models: {} };
}

export function loadAdaptiveModelLimits(filePath: string): AdaptiveModelLimitsStateV1 {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AdaptiveModelLimitsStateV1> | null;
    if (
      !parsed ||
      parsed.version !== ADAPTIVE_MODEL_LIMITS_VERSION ||
      !parsed.models ||
      typeof parsed.models !== "object"
    )
      return defaultState();
    return {
      version: ADAPTIVE_MODEL_LIMITS_VERSION,
      models: parsed.models as Record<string, AdaptiveModelLimitEntryV1>,
    };
  } catch {
    return defaultState();
  }
}

export function saveAdaptiveModelLimits(filePath: string, state: AdaptiveModelLimitsStateV1): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export type EffectiveModelLimits = {
  batchTokenLimit: number;
  maxOutputTokens: number;
  source: "catalog" | "adaptive";
};

export function getEffectiveModelLimits(opts: {
  state: AdaptiveModelLimitsStateV1;
  model: string;
  catalogBatchTokenLimit: number;
  catalogMaxOutputTokens: number;
  minBatchTokenLimit?: number;
  minMaxOutputTokens?: number;
}): EffectiveModelLimits {
  const { state, model, catalogBatchTokenLimit, catalogMaxOutputTokens } = opts;
  const minBatch = opts.minBatchTokenLimit ?? 1024;
  const minOut = opts.minMaxOutputTokens ?? 128;
  const entry = state.models[model];
  if (!entry) {
    return {
      batchTokenLimit: clampInt(catalogBatchTokenLimit, minBatch, catalogBatchTokenLimit),
      maxOutputTokens: clampInt(catalogMaxOutputTokens, minOut, catalogMaxOutputTokens),
      source: "catalog",
    };
  }
  return {
    batchTokenLimit: clampInt(entry.safeBatchTokenLimit, minBatch, catalogBatchTokenLimit),
    maxOutputTokens: clampInt(entry.safeMaxOutputTokens, minOut, catalogMaxOutputTokens),
    source: "adaptive",
  };
}

export function recordAdaptiveSuccess(opts: {
  state: AdaptiveModelLimitsStateV1;
  model: string;
  catalogBatchTokenLimit: number;
  catalogMaxOutputTokens: number;
  usedBatchTokenLimit: number;
  usedMaxOutputTokens: number;
  /** How fast to grow on success (default 1.05 = +5%). */
  growFactor?: number;
}): void {
  const {
    state,
    model,
    catalogBatchTokenLimit,
    catalogMaxOutputTokens,
    usedBatchTokenLimit,
    usedMaxOutputTokens,
    growFactor = 1.05,
  } = opts;
  const now = Date.now();
  const cur = state.models[model];
  const nextBatch = clampInt(Math.ceil(usedBatchTokenLimit * growFactor), 1024, catalogBatchTokenLimit);
  const nextOut = clampInt(Math.ceil(usedMaxOutputTokens * growFactor), 128, catalogMaxOutputTokens);
  state.models[model] = {
    safeBatchTokenLimit: nextBatch,
    safeMaxOutputTokens: nextOut,
    updatedAtMs: now,
    lastSuccessAtMs: now,
    consecutiveFailures: 0,
    ...(cur?.lastFailureAtMs != null ? { lastFailureAtMs: cur.lastFailureAtMs } : {}),
    ...(cur?.lastFailureKind != null ? { lastFailureKind: cur.lastFailureKind } : {}),
  };
}

function shrinkFactor(kind: AdaptiveFailureKind): number {
  if (kind === "context_length") return 0.6;
  if (kind === "timeout") return 0.75;
  if (kind === "rate_limit" || kind === "quota") return 0.85;
  return 0.8;
}

export function recordAdaptiveFailure(opts: {
  state: AdaptiveModelLimitsStateV1;
  model: string;
  kind: AdaptiveFailureKind;
  catalogBatchTokenLimit: number;
  catalogMaxOutputTokens: number;
  usedBatchTokenLimit: number;
  usedMaxOutputTokens: number;
}): void {
  const {
    state,
    model,
    kind,
    catalogBatchTokenLimit,
    catalogMaxOutputTokens,
    usedBatchTokenLimit,
    usedMaxOutputTokens,
  } = opts;
  const now = Date.now();
  const cur = state.models[model];
  const factor = shrinkFactor(kind);
  const nextBatch = clampInt(Math.floor(usedBatchTokenLimit * factor), 1024, catalogBatchTokenLimit);
  // Output limits: only shrink meaningfully on timeouts/context-length; keep modest adjustments otherwise.
  const outFactor = kind === "timeout" || kind === "context_length" ? Math.min(0.9, factor) : 0.95;
  const nextOut = clampInt(Math.floor(usedMaxOutputTokens * outFactor), 128, catalogMaxOutputTokens);
  const consecutiveFailures = (cur?.consecutiveFailures ?? 0) + 1;
  state.models[model] = {
    safeBatchTokenLimit: nextBatch,
    safeMaxOutputTokens: nextOut,
    updatedAtMs: now,
    lastFailureAtMs: now,
    lastFailureKind: kind,
    consecutiveFailures,
    ...(cur?.lastSuccessAtMs != null ? { lastSuccessAtMs: cur.lastSuccessAtMs } : {}),
  };
}
