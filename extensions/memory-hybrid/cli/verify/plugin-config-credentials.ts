import { getPluginConfigFromFile } from "../cmd-install.js";
import type { VerifyRunState } from "./verify-run-state.js";

export function ensureRawPluginConfigOnState(state: VerifyRunState): void {
  if (state.rawPluginConfig !== undefined) return;
  const rawPluginConfigResult = getPluginConfigFromFile(state.defaultConfigPath);
  state.rawPluginConfig = "error" in rawPluginConfigResult ? undefined : rawPluginConfigResult.config;
  if ("error" in rawPluginConfigResult && state.openclawConfigRead.exists && state.openclawConfigRead.error === undefined) {
    state.warnings.push(
      `OpenClaw config at ${state.defaultConfigPath} could not be interpreted for plugin settings (${rawPluginConfigResult.error}).`,
    );
  }
}

export function credentialSource(rawKey: unknown): string {
  if (typeof rawKey !== "string" || !rawKey.trim()) return "";
  const v = rawKey.trim();
  if (v.startsWith("env:")) return "env";
  if (v.startsWith("file:")) return "file";
  return "plugin";
}

export function rawEmbeddingApiKey(state: VerifyRunState): unknown {
  const emb = state.rawPluginConfig?.embedding as Record<string, unknown> | undefined;
  return emb?.apiKey;
}

export function rawDistillApiKey(state: VerifyRunState): unknown {
  const d = state.rawPluginConfig?.distill as Record<string, unknown> | undefined;
  return d?.apiKey;
}

export function rawLlmProviderApiKey(state: VerifyRunState, provider: string): unknown {
  const prov = (state.rawPluginConfig?.llm as Record<string, unknown> | undefined)?.providers as
    | Record<string, unknown>
    | undefined;
  const p = prov?.[provider] as Record<string, unknown> | undefined;
  return p?.apiKey;
}

export function rawClaudeApiKey(state: VerifyRunState): unknown {
  const c = state.rawPluginConfig?.claude as Record<string, unknown> | undefined;
  return c?.apiKey;
}
