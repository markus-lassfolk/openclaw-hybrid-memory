/**
 * Session pre-filter: use a local Ollama model to triage sessions
 * before expensive cloud LLM extraction (Issue #290).
 *
 * Two-tier architecture:
 *   Tier 1 — Local Ollama (free, fast): classifies each session as interesting or not.
 *   Tier 2 — Cloud LLM (paid): only processes sessions flagged as interesting.
 *
 * If Ollama is unavailable, all sessions pass through (safe fallback).
 *
 * For Qwen3 / thinking models: append "/no_think" suffix to the model name in config
 * (e.g. "qwen3:8b/no_think") to disable chain-of-thought and get faster, shorter responses.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import OpenAI from "openai";
import {
	chatComplete,
	isConnectionErrorLike,
	isContextLengthError,
} from "./chat.js";
import { CostFeature } from "./cost-feature-labels.js";
import { capturePluginError } from "./error-reporter.js";

/** Configuration for local LLM pre-filtering. */
export type PreFilterConfig = {
	/** Whether pre-filtering is enabled. */
	enabled: boolean;
	/**
	 * Ollama model name (without "ollama/" prefix), e.g. "qwen3:8b".
	 * For Qwen3 thinking models, append the "/no_think" suffix (e.g. "qwen3:8b/no_think")
	 * to disable chain-of-thought and avoid exhausting the token budget inside <think> blocks.
	 */
	model: string;
	/** Ollama base URL (default: http://localhost:11434). */
	endpoint: string;
	/**
	 * Max characters of user messages extracted per session for triage (default: 2000).
	 * Only user messages are extracted — assistant messages and tool calls are ignored.
	 */
	maxCharsPerSession: number;
};

/** Result of pre-filtering a batch of session files. */
type PreFilterResult = {
	/** Paths that the local model flagged as containing extractable content. */
	kept: string[];
	/** Paths the local model classified as not interesting. */
	skipped: string[];
	/**
	 * True when the Ollama endpoint was unreachable.
	 * In this case, all sessions are in `kept` (safe fallback).
	 */
	ollamaUnavailable: boolean;
};

/**
 * Prompt sent to the local model for each session.
 * Binary YES/NO classification — conservative bias toward YES to avoid missing signals.
 */
const PRE_FILTER_PROMPT = `You are a session triage assistant. Review this conversation excerpt and decide if it contains any of:
- User preferences or behavioral rules ("always do X", "never Y", "I prefer", "remember", "from now on")
- User corrections or nudges ("that's wrong", "no, actually", "stop doing", "you should have")
- Positive reinforcement/praise ("perfect", "exactly right", "great job", "that's what I wanted")
- Procedural steps or workflows the agent demonstrated
- Important facts or decisions about the user's project

Answer with exactly one word: YES if any of these are present, NO if the session is purely mechanical (heartbeat, cron, compaction, subagent announce, empty).

SESSION EXCERPT:
`;

const SKIP_PATTERNS = [
	/heartbeat/i,
	/cron\s+job|cronjob/i,
	/compact|pre-compaction/i,
	/sub-?agent|subagent\s+announce/i,
	/NO_REPLY/i,
];

/**
 * Strip the "ollama/" provider prefix from a model name if present.
 * The Ollama native API expects bare model names like "qwen3:8b", not "ollama/qwen3:8b".
 */
function stripOllamaPrefix(model: string): string {
	return model.replace(/^ollama\//, "");
}

/**
 * Create an OpenAI-compatible client pointing at a local Ollama instance.
 * Ollama exposes an OpenAI-compatible `/v1` endpoint.
 */
function createOllamaClient(endpoint: string): OpenAI {
	const baseURL = `${endpoint.replace(/\/+$/, "")}/v1`;
	return new OpenAI({
		apiKey: "ollama", // Ollama does not require a real API key
		baseURL,
		timeout: 25_000,
	});
}

/**
 * Extract a sample of user messages from a session JSONL file for triage.
 * Only user messages are extracted (they contain the actionable signals).
 * Skips known non-actionable messages (heartbeat, cron, etc.).
 *
 * Uses a readline stream to avoid loading the entire file into memory —
 * safe for large or runaway session files, with early exit once maxChars is reached.
 */
export async function extractSessionSample(
	filePath: string,
	maxChars: number,
): Promise<string> {
	const parts: string[] = [];
	let totalChars = 0;
	try {
		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf-8" }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		for await (const line of rl) {
			if (totalChars >= maxChars) break;
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const obj = JSON.parse(trimmed) as {
					type?: string;
					message?: { role?: string; content?: unknown };
				};
				if (obj.type !== "message" || !obj.message) continue;
				if (obj.message.role !== "user") continue;

				const content = obj.message.content;
				let text = "";
				if (Array.isArray(content)) {
					for (const block of content as Array<{
						type?: string;
						text?: string;
					}>) {
						if (block?.type === "text" && typeof block.text === "string") {
							text += `${block.text} `;
						}
					}
				} else if (typeof content === "string") {
					text = content;
				}
				text = text.trim();
				if (!text || text.length < 10) continue;

				// Skip obvious non-actionable messages early
				let skip = false;
				for (const re of SKIP_PATTERNS) {
					if (re.test(text)) {
						skip = true;
						break;
					}
				}
				if (skip) continue;

				const chunk = text.slice(0, 500);
				parts.push(chunk);
				totalChars += chunk.length;
			} catch {
				// skip malformed lines
			}
		}
	} catch {
		return "";
	}
	return parts.join("\n").slice(0, maxChars);
}

/**
 * Classify a single session via the local Ollama model.
 * Returns true if the session contains extractable content.
 * @throws When Ollama is unreachable (connection error) — caller handles this.
 */
async function classifySession(
	sample: string,
	config: PreFilterConfig,
	ollamaClient: OpenAI,
): Promise<boolean> {
	const prompt = PRE_FILTER_PROMPT + sample;
	const model = stripOllamaPrefix(config.model);

	const response = await chatComplete({
		model,
		content: prompt,
		temperature: 0,
		maxTokens: 512, // extra budget for thinking-model <think> preamble before YES/NO
		openai: ollamaClient,
		timeoutMs: 20_000,
		feature: CostFeature.sessionPreFilter,
	});

	// For thinking models: extract only the text after the final </think> tag.
	// This ensures we classify based on the final answer, not reasoning inside <think> blocks.
	const lastThinkEnd = response.lastIndexOf("</think>");
	const finalAnswer =
		lastThinkEnd >= 0 ? response.slice(lastThinkEnd + 8) : response;

	// Use word-boundary matching to avoid false positives from substrings like
	// "UNKNOWN", "CANNOT", "NOTICE", "NOTABLE" matching "NO".
	const upper = finalAnswer.toUpperCase();
	if (/\bYES\b/.test(upper)) return true;
	if (/\bNO\b/.test(upper)) return false;

	// Ambiguous response — conservative: treat as interesting
	return true;
}

/**
 * Determine whether a chatComplete error is a fatal Ollama-level failure that
 * should short-circuit the entire batch (avoid thousands of failing requests).
 * Covers both connection errors (Ollama down) and HTTP 404/5xx (model not found
 * or server error) — all of which indicate Ollama cannot serve the request.
 */
function isConnectionError(err: unknown): boolean {
	if (isConnectionErrorLike(err)) return true;
	const msg = err instanceof Error ? err.message : String(err);
	if (
		/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|connect\s+ETIMEDOUT|socket hang up|LLM request timeout/i.test(
			msg,
		)
	) {
		return true;
	}
	// HTTP 404 (model not found) or 5xx (server error) should also abort the batch.
	if (err !== null && typeof err === "object" && "status" in err) {
		const status = (err as { status?: unknown }).status;
		if (typeof status === "number" && (status === 404 || status >= 500))
			return true;
	}
	return false;
}

/**
 * Pre-filter session files using a local Ollama model.
 *
 * Each session is classified as interesting (kept) or not (skipped).
 * Sessions with no extractable user messages are always skipped.
 * If Ollama is unreachable, all sessions are returned as kept (safe fallback).
 *
 * @param filePaths - Absolute paths to session JSONL files.
 * @param config - Pre-filter configuration.
 * @param opts - Optional overrides (e.g. inject a mock client for tests).
 */
export async function preFilterSessions(
	filePaths: string[],
	config: PreFilterConfig,
	opts?: { ollamaClient?: OpenAI },
): Promise<PreFilterResult> {
	if (!config.enabled || filePaths.length === 0) {
		return { kept: filePaths, skipped: [], ollamaUnavailable: false };
	}

	const ollamaClient =
		opts?.ollamaClient ?? createOllamaClient(config.endpoint);
	const kept: string[] = [];
	const skipped: string[] = [];
	let ollamaUnavailable = false;

	for (const filePath of filePaths) {
		// Once we know Ollama is unavailable, stop classifying and keep everything
		if (ollamaUnavailable) {
			kept.push(filePath);
			continue;
		}

		const sample = await extractSessionSample(
			filePath,
			config.maxCharsPerSession,
		);
		if (!sample.trim()) {
			// No actionable user messages found — skip this session
			skipped.push(filePath);
			continue;
		}

		try {
			const interesting = await classifySession(sample, config, ollamaClient);
			if (interesting) {
				kept.push(filePath);
			} else {
				skipped.push(filePath);
			}
		} catch (err) {
			if (isConnectionError(err)) {
				// Ollama unreachable — fallback: keep this and all remaining sessions
				ollamaUnavailable = true;
				kept.push(filePath);
			} else if (isContextLengthError(err)) {
				// #488: Input too long for this model's context window — retry with a halved sample.
				// The model has a small context window (e.g. 512 tokens); truncating the input may fit.
				const truncated = sample.slice(0, Math.floor(sample.length / 2));
				if (truncated.trim()) {
					try {
						const interesting = await classifySession(
							truncated,
							config,
							ollamaClient,
						);
						if (interesting) {
							kept.push(filePath);
						} else {
							skipped.push(filePath);
						}
					} catch (retryErr) {
						if (isConnectionError(retryErr)) {
							ollamaUnavailable = true;
						}
						// Truncated input also too long, connection error, or other failure — keep conservatively
						kept.push(filePath);
					}
				} else {
					// Sample too short to truncate further — keep conservatively
					kept.push(filePath);
				}
			} else {
				// Other error (model error, bad response, etc.) — conservative: keep session
				capturePluginError(
					err instanceof Error ? err : new Error(String(err)),
					{
						subsystem: "session-pre-filter",
						operation: "classify-session",
						severity: "info",
					},
				);
				kept.push(filePath);
			}
		}
	}

	return { kept, skipped, ollamaUnavailable };
}
