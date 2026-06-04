import { normalizeResolvedSecretValue } from "../config/parsers/core.js";
import { getEnv } from "./env-manager.js";

/** Agent target model id required by OpenClaw gateway OpenAI-compatible HTTP APIs. */
export const OPENCLAW_GATEWAY_AGENT_MODEL = "openclaw";

/** Resolve local gateway `/v1` base URL from `OPENCLAW_GATEWAY_PORT` (same shape as provider-router). */
export function resolveOpenClawGatewayBaseUrlFromEnv(): string | undefined {
  const gatewayPortRaw = normalizeResolvedSecretValue(getEnv("OPENCLAW_GATEWAY_PORT"));
  const gatewayPort = gatewayPortRaw ? Number.parseInt(gatewayPortRaw, 10) : undefined;
  if (!gatewayPort || gatewayPort < 1 || gatewayPort > 65535) return undefined;
  return `http://127.0.0.1:${gatewayPort}/v1`;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** True when `baseURL` points at the OpenClaw gateway HTTP `/v1` surface. */
export function isOpenClawGatewayBaseUrl(baseURL: string | undefined, gatewayBaseUrl?: string): boolean {
  const gw = gatewayBaseUrl ?? resolveOpenClawGatewayBaseUrlFromEnv();
  if (!baseURL || !gw) return false;
  return normalizeBaseUrl(baseURL) === normalizeBaseUrl(gw);
}

export function readOpenAiClientBaseUrl(client: unknown): string | undefined {
  if (!client || typeof client !== "object") return undefined;
  const baseURL = (client as { baseURL?: string }).baseURL;
  return typeof baseURL === "string" && baseURL.trim() ? baseURL.trim() : undefined;
}

/** True when an OpenAI SDK client is configured to call the local OpenClaw gateway. */
export function isOpenClawGatewayClient(client: unknown, gatewayBaseUrl?: string): boolean {
  return isOpenClawGatewayBaseUrl(readOpenAiClientBaseUrl(client), gatewayBaseUrl);
}

/**
 * Apply OpenClaw gateway agent-first model contract:
 * - HTTP `model` must be `openclaw` (or `openclaw/<agentId>`)
 * - Backend provider model goes in `x-openclaw-model`
 */
export function applyOpenClawGatewayModelRequest<T extends Record<string, unknown>>(
  body: T,
  backendModel: string,
  opts?: unknown,
  agentModel: string = OPENCLAW_GATEWAY_AGENT_MODEL,
): { body: T; opts: Record<string, unknown> } {
  const priorOpts = (opts && typeof opts === "object" ? opts : {}) as Record<string, unknown>;
  const priorHeaders =
    priorOpts.headers && typeof priorOpts.headers === "object" && !Array.isArray(priorOpts.headers)
      ? (priorOpts.headers as Record<string, string>)
      : {};
  return {
    body: { ...body, model: agentModel },
    opts: {
      ...priorOpts,
      headers: {
        ...priorHeaders,
        "x-openclaw-model": backendModel.trim(),
      },
    },
  };
}
