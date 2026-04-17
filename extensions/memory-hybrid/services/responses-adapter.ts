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
	content: Array<
		| { type: "output_text"; text: string }
		| { type: string; [key: string]: unknown }
	>;
}

export interface ResponsesApiResponse {
	id: string;
	output: Array<
		ResponseOutputMessage | { type: string; [key: string]: unknown }
	>;
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
export function buildResponsesRequestBody(
	params: ResponsesCreateParams,
): ResponsesApiRequest {
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
				if (
					part.type === "output_text" &&
					typeof part.text === "string" &&
					part.text.trim()
				) {
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

/** Normalize OpenAI chat `message.content` to a single string for Responses `input`. */
export function chatMessageContentToString(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const part of content) {
			if (
				part &&
				typeof part === "object" &&
				"text" in part &&
				typeof (part as { text: unknown }).text === "string"
			) {
				parts.push((part as { text: string }).text);
			}
		}
		return parts.join("\n");
	}
	return "";
}

type ResponsesInputItem = {
	role: "user" | "system" | "assistant" | "developer";
	content: string;
};

/**
 * Map chat.completions `messages` to Responses API `input` items.
 * Tool messages are folded into user-shaped input with a prefix (Responses has no tool role in this adapter).
 */
export function chatMessagesToResponsesInput(
	messages: unknown,
): ResponsesInputItem[] {
	if (!Array.isArray(messages)) return [];
	const out: ResponsesInputItem[] = [];
	for (const m of messages) {
		if (!m || typeof m !== "object") continue;
		const msg = m as { role?: string; content?: unknown };
		const rawRole = (msg.role ?? "user").toLowerCase();
		const text = chatMessageContentToString(msg.content);
		if (rawRole === "tool") {
			out.push({ role: "user", content: `[tool result]\n${text}` });
			continue;
		}
		const role =
			rawRole === "system"
				? "system"
				: rawRole === "assistant"
					? "assistant"
					: rawRole === "developer"
						? "developer"
						: "user";
		out.push({ role, content: text });
	}
	return out;
}

/**
 * Build a `responses.create` body from a non-streaming chat.completions-style payload
 * (after provider-router token remapping). Used when routing `chat.completions.create` to Responses.
 */
export function buildResponsesRequestFromChatBody(
	merged: Record<string, unknown>,
): Record<string, unknown> {
	const model = String(merged.model ?? "");
	const input = chatMessagesToResponsesInput(merged.messages);
	const maxTokens =
		typeof merged.max_completion_tokens === "number"
			? merged.max_completion_tokens
			: typeof merged.max_tokens === "number"
				? merged.max_tokens
				: undefined;
	const body: Record<string, unknown> = {
		model,
		input,
		stream: false,
	};
	if (maxTokens != null) {
		body.max_output_tokens = maxTokens;
	}
	if (!isReasoningModel(model) && typeof merged.temperature === "number") {
		body.temperature = merged.temperature;
	}
	return body;
}

/**
 * Map a Responses API JSON object to a minimal {@link OpenAI.Chat.ChatCompletion}-shaped result
 * so call sites using `openai.chat.completions.create` keep working.
 */
export function responsesRawToChatCompletion(
	raw: ResponsesApiResponse,
	modelIdForResponse: string,
): import("openai").OpenAI.Chat.ChatCompletion {
	const text = extractResponsesText(raw);
	const u = extractResponsesUsage(raw);
	return {
		id: raw.id,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: modelIdForResponse,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: text },
				finish_reason: "stop",
			},
		],
		usage: u
			? {
					prompt_tokens: u.prompt_tokens,
					completion_tokens: u.completion_tokens,
					total_tokens: u.prompt_tokens + u.completion_tokens,
				}
			: undefined,
	} as import("openai").OpenAI.Chat.ChatCompletion;
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
		client as unknown as {
			responses?: {
				create: (body: unknown, opts?: unknown) => Promise<unknown>;
			};
		}
	).responses;
	if (!responsesNamespace?.create) {
		throw new Error(
			"OpenAI SDK does not expose responses.create(). Upgrade the openai package to >=6.16.0 or use a provider that supports the Responses API.",
		);
	}

	const raw = (await responsesNamespace.create(
		body,
		requestOpts ?? {},
	)) as ResponsesApiResponse;
	const text = extractResponsesText(raw);
	return { text, raw };
}
