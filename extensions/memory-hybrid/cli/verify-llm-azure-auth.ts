/**
 * Azure Foundry / APIM / direct resource auth for `verify --test-llm` OpenAI SDK clients (#994).
 * The SDK defaults to Bearer; Azure OpenAI resource and APIM expect `api-key` (same as embeddings factory).
 */

import { AZURE_OPENAI_API_VERSION } from "../services/embeddings.js";
import { isAzureOpenAiResourceEndpoint } from "../services/embeddings/shared.js";

/** True when baseURL is an Azure AI Foundry Services endpoint (e.g. https://services.ai.azure.com). */
function isAzureAiFoundryServicesUrl(baseURL: string): boolean {
  try {
    const u = new URL(baseURL);
    return u.hostname === "services.ai.azure.com" || u.hostname.endsWith(".services.ai.azure.com");
  } catch {
    return false;
  }
}
import { createApimGatewayFetch, isAzureApiManagementGatewayUrl } from "../utils/apim-gateway-fetch.js";

export function isAzureFoundryFamilyProvider(provider: string): boolean {
  return provider === "azure-foundry" || provider === "azure-foundry-responses" || provider === "azure-foundry-direct";
}

export type VerifyDirectOpenAIOpts = {
  apiKey: string;
  baseURL: string;
  defaultHeaders?: Record<string, string>;
  defaultQuery?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
};

/**
 * Mutates `opts` when `provider` is an Azure Foundry family and `baseURL` is APIM or a direct Azure resource host.
 */
export function applyAzureFoundryVerifyDirectClientAuth(
  opts: VerifyDirectOpenAIOpts,
  provider: string,
  apiKey: string,
): void {
  if (!isAzureFoundryFamilyProvider(provider)) return;
  const { baseURL } = opts;
  if (isAzureApiManagementGatewayUrl(baseURL)) {
    opts.defaultHeaders = { ...(opts.defaultHeaders ?? {}), "api-key": apiKey };
    opts.fetch = createApimGatewayFetch(apiKey);
    const openAiV1Compat = /\/openai\/v1(?:\/|$)/i.test(baseURL);
    if (!openAiV1Compat) {
      opts.defaultQuery = { "api-version": AZURE_OPENAI_API_VERSION };
    }
  } else if (isAzureOpenAiResourceEndpoint(baseURL)) {
    // Legacy Azure OpenAI resource (e.g. *.openai.azure.com without /openai/v1)
    opts.defaultHeaders = { ...(opts.defaultHeaders ?? {}), "api-key": apiKey };
    const openAiV1Compat = /\/openai\/v1(?:\/|$)/i.test(baseURL);
    if (!openAiV1Compat) {
      opts.defaultQuery = { "api-version": AZURE_OPENAI_API_VERSION };
    }
  } else if (isAzureAiFoundryServicesUrl(baseURL)) {
    // Azure AI Foundry Services endpoint — requires Bearer token auth (#1125)
    opts.defaultHeaders = { ...(opts.defaultHeaders ?? {}), Authorization: `Bearer ${apiKey}` };
  }
}
