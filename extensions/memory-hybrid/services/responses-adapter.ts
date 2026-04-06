/**
 * Adapter for the OpenAI Responses API (responses.create).
 *
 * Translates the plugin's standard "messages + model + max_tokens" interface
 * into the Responses API request shape and maps the response back to a plain
 * assistant-text string so callers (chatComplete, chatCompleteWithRetry) are
 * API-surface-agnostic.
 *
 * The Responses API uses `input` (string or array of items) instead of `messages`,
 * and returns `output` items instead of `choices[].message.content`.
 */

import type OpenAI from "openai";
import { isReasoningModel } from "./model-capabilities.js";

export interface ResponsesCreateParams {
  model: string;
  content: string;
  temperature?: number;
  maxTokens?: number;
}

interface ResponsesApiInput {
  role: "user" | "system" | "assistant" | "developer";
  content: string;
}

interface ResponsesApiRequest {
  model: string;
  input: ResponsesApiInput[];
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface ResponseOutputMessage {
  type: "message";
  role: "assistant";
  content: Array<{ type: "output_text"; text: string } | { type: string; [key: string]: unknown }>;
}

interface ResponsesApiResponse {
  id: string;
  output: Array<ResponseOutputMessage | { type: string; [key: string]: unknown }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Build the Responses API request body from standard chat parameters.
 * Exported for unit testing.
 */
export function buildResponsesRequestBody(params: ResponsesCreateParams): ResponsesApiRequest {
  const { model, content, temperature, maxTokens } = params;
  const body: ResponsesApiRequest = {
    model,
    input: [{ role: "user", content }],
    stream: false,
  };
  if (maxTokens != null) {
    body.max_output_tokens = maxTokens;
  }
  if (!isReasoningModel(model) && temperature != null) {
    body.temperature = temperature;
  }
  return body;
}

/**
 * Extract the first assistant text from a Responses API response.
 * Returns empty string if no text output is found.
 */
export function extractResponsesText(response: ResponsesApiResponse): string {
  for (const item of response.output ?? []) {
    if (item.type === "message" && "content" in item) {
      const msg = item as ResponseOutputMessage;
      for (const part of msg.content) {
        if (part.type === "output_text" && typeof part.text === "string" && part.text.trim()) {
          return part.text.trim();
        }
      }
    }
  }
  return "";
}

/**
 * Extract usage from a Responses API response in a format compatible with the cost tracker.
 * Responses API uses input_tokens/output_tokens instead of prompt_tokens/completion_tokens.
 */
export function extractResponsesUsage(
  response: ResponsesApiResponse,
): { prompt_tokens: number; completion_tokens: number } | undefined {
  if (!response.usage) return undefined;
  return {
    prompt_tokens: response.usage.input_tokens ?? 0,
    completion_tokens: response.usage.output_tokens ?? 0,
  };
}

/**
 * Call the OpenAI Responses API via the SDK's `responses.create()` method.
 *
 * The SDK (openai ^6.16+) exposes `client.responses.create(body)` which maps
 * to POST /v1/responses. This adapter:
 *  1. Builds the request from standard chat-style params.
 *  2. Calls `client.responses.create(body, requestOpts)`.
 *  3. Returns the extracted assistant text and raw response for cost tracking.
 */
export async function callResponsesApi(
  client: OpenAI,
  params: ResponsesCreateParams,
  requestOpts?: { signal?: AbortSignal },
): Promise<{ text: string; raw: ResponsesApiResponse }> {
  const body = buildResponsesRequestBody(params);

  const responsesNamespace = (
    client as unknown as { responses?: { create: (body: unknown, opts?: unknown) => Promise<unknown> } }
  ).responses;
  if (!responsesNamespace?.create) {
    throw new Error(
      "OpenAI SDK does not expose responses.create(). Upgrade the openai package to >=6.16.0 or use a provider that supports the Responses API.",
    );
  }

  const raw = (await responsesNamespace.create(body, requestOpts ?? {})) as ResponsesApiResponse;
  const text = extractResponsesText(raw);
  return { text, raw };
}
