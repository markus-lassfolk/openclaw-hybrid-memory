import type { MiniMaxThinkingMode } from "../services/chat.js";
import type { HybridMemoryConfig } from "./types/index.js";

function parseTaskThinking(raw: unknown): MiniMaxThinkingMode | undefined {
  if (raw === "disabled" || raw === "adaptive") return raw;
  return undefined;
}

/** Resolve MiniMax M3 thinking mode from config (default: disabled for structured JSON maintenance). */
export function resolveMiniMaxThinkingMode(
  cfg: Pick<HybridMemoryConfig, "llm"> | undefined,
  override?: "disabled" | "adaptive",
): MiniMaxThinkingMode {
  if (override === "disabled" || override === "adaptive") return override;
  const fromCfg = cfg?.llm?.minimax?.thinking;
  if (fromCfg === "disabled" || fromCfg === "adaptive") return fromCfg;
  return "disabled";
}

/** Per-task thinking with fallback to llm.minimax.thinking (default disabled). */
export function resolveTaskThinkingMode(
  cfg: HybridMemoryConfig | undefined,
  taskThinking: unknown,
): MiniMaxThinkingMode {
  const parsed = parseTaskThinking(taskThinking);
  if (parsed) return parsed;
  return resolveMiniMaxThinkingMode(cfg);
}

export function resolveSelfCorrectionThinkingMode(cfg: HybridMemoryConfig | undefined): MiniMaxThinkingMode {
  return resolveTaskThinkingMode(cfg, cfg?.selfCorrection?.thinking);
}

export function resolveReinforcementThinkingMode(cfg: HybridMemoryConfig | undefined): MiniMaxThinkingMode {
  return resolveTaskThinkingMode(cfg, cfg?.reinforcement?.thinking);
}

export function resolveDistillThinkingMode(cfg: HybridMemoryConfig | undefined): MiniMaxThinkingMode {
  return resolveTaskThinkingMode(cfg, cfg?.distill?.thinking);
}

export function resolveReflectionThinkingMode(cfg: HybridMemoryConfig | undefined): MiniMaxThinkingMode {
  return resolveTaskThinkingMode(cfg, cfg?.reflection?.thinking);
}
