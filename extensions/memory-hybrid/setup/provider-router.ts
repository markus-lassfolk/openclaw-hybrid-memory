/** @module provider-router — Multi-provider LLM routing (OpenAI-compatible) and API key resolution. */
import OpenAI from "openai";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { CostTracker } from "../backends/cost-tracker.js";
import type {
	HybridMemoryConfig,
	LLMProviderConfig,
	ResolvedGatewayAuthConfig,
} from "../config.js";
import {
	EMBEDDING_DIMENSIONS,
	OPENAI_MODELS,
	normalizeResolvedSecretValue,
	resolveSecretRef,
} from "../config/parsers/core.js";
import { UnconfiguredProviderError } from "../services/chat.js";
import { isAzureOpenAiResourceEndpoint } from "../services/embeddings/shared.js";
import {
	isReasoningModel,
	requiresMaxCompletionTokens,
	resolveWireApi,
} from "../services/model-capabilities.js";
import {
	type ResponsesApiResponse,
	buildResponsesRequestFromChatBody,
	responsesRawToChatCompletion,
} from "../services/responses-adapter.js";
import {
	createApimGatewayFetch,
	isAzureApiManagementGatewayUrl,
} from "../utils/apim-gateway-fetch.js";
import {
	DEFAULT_BACKOFF_MINUTES,
	DEFAULT_RESET_AFTER_HOURS,
	isOAuthInBackoff,
	recordOAuthFailure,
} from "../utils/auth-failover.js";
import { hasOAuthProfiles } from "../utils/auth.js";
import { getEnv } from "../utils/env-manager.js";
import { inferFeatureLabel } from "./cost-instrumentation.js";

/**
 * Normalize baseURL vs baseUrl (OpenClaw config uses camelCase `baseUrl`; SDK uses `baseURL`).
 * Intentionally duplicated from config/parsers/index.ts to avoid a circular module dependency —
 * init-databases bootstraps before the full config parser is available.
 */
export function readProviderBaseUrl(
	p: { baseURL?: string; baseUrl?: string } | undefined,
): string | undefined {
	if (!p) return undefined;
	const u =
		typeof p.baseURL === "string"
			? p.baseURL
			: typeof p.baseUrl === "string"
				? p.baseUrl
				: undefined;
	const t = u?.trim();
	return t && t.length > 0 ? t : undefined;
}

/**
 * Embeddings are created before `models.providers` is merged into `cfg.llm`. If `embedding.endpoint`
 * was stripped by the host validator or omitted, inherit the APIM / Foundry base from the global
 * `models.providers["azure-foundry"]` entry so requests do not fall through to api.openai.com with
 * an Azure or subscription key (401 "Incorrect API key" from platform.openai.com).
 */
/** OpenClaw gateway `models.providers` (or legacy `llm.providers` / top-level `providers`). */
export function getGatewayModelsProviders(
	gwConfig: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!gwConfig) return undefined;
	const p =
		(gwConfig.models as Record<string, unknown> | undefined)?.providers ??
		(gwConfig.llm as Record<string, unknown> | undefined)?.providers ??
		gwConfig.providers;
	if (!p || typeof p !== "object" || Array.isArray(p)) return undefined;
	return p as Record<string, unknown>;
}

export function patchEmbeddingEndpointFromGatewayProviders(
	cfg: HybridMemoryConfig,
	api: ClawdbotPluginApi,
): void {
	const ep = cfg.embedding?.endpoint;
	if (typeof ep === "string" && ep.trim().length > 0) return;
	// Only inherit Azure Foundry endpoint for OpenAI provider
	if (cfg.embedding?.provider !== "openai") return;
	const gwConfig = api.config as Record<string, unknown> | undefined;
	const gwProviders = getGatewayModelsProviders(gwConfig);
	const af = gwProviders?.["azure-foundry"] as
		| { baseURL?: string; baseUrl?: string }
		| undefined;
	const base = readProviderBaseUrl(af);
	if (!base) return;
	(cfg.embedding as Record<string, unknown>).endpoint = base;
	api.logger?.info?.(
		`memory-hybrid: embedding.endpoint was empty — using models.providers["azure-foundry"] base URL (${base})`,
	);
}

/** Existing `llm.providers` key whose name matches `normalizedName` case-insensitively (issue #1002 / PR #1003). */
function findLlmProviderSlotKey(
	prov: Record<string, Record<string, unknown>>,
	normalizedName: string,
): string | undefined {
	for (const k of Object.keys(prov)) {
		if (k.toLowerCase() === normalizedName) return k;
	}
	return undefined;
}

function llmProviderEntryAsPlainObject(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object" && !Array.isArray(raw))
		return { ...(raw as Record<string, unknown>) };
	return {};
}

/**
 * Merge gateway `models.providers` apiKey/baseURL into plugin `llm.providers` (issues #487, #386).
 * Optionally records merged provider names for bootstrap tier-list augmentation.
 * Resolves mixed-case plugin keys (e.g. `OpenAI`) so gateway merge does not add a duplicate lowercase entry.
 */
export function mergeGatewayProviderCredentialsIntoLlmProvidersMap(
	prov: Record<string, Record<string, unknown>>,
	gwProviders: Record<string, unknown> | undefined,
	api: Pick<ClawdbotPluginApi, "logger">,
	mergedNames?: string[],
	mergedOriginals?: Map<string, string>,
): number {
	let newApiKeySlots = 0;
	if (
		!gwProviders ||
		typeof gwProviders !== "object" ||
		Array.isArray(gwProviders)
	)
		return 0;
	for (const [name, gw] of Object.entries(gwProviders)) {
		if (!name || !gw || typeof gw !== "object") continue;
		const rawKey =
			(gw as Record<string, unknown>).apiKey ??
			(gw as Record<string, unknown>).api_key;
		if (typeof rawKey !== "string" || !rawKey.trim()) continue;
		const normalizedName = name.toLowerCase();
		const slotKey = findLlmProviderSlotKey(prov, normalizedName);
		const targetKey = slotKey ?? normalizedName;
		const cur = llmProviderEntryAsPlainObject(prov[targetKey]);
		const pluginHasKey =
			typeof cur.apiKey === "string" &&
			(cur.apiKey as string).trim().length > 0;
		if (!pluginHasKey) {
			newApiKeySlots++;
			prov[targetKey] = {
				...cur,
				apiKey: rawKey.trim(),
				baseURL:
					(typeof cur.baseURL === "string" && cur.baseURL.trim()
						? cur.baseURL
						: undefined) ??
					(gw as Record<string, unknown>).baseURL ??
					(gw as Record<string, unknown>).base_url ??
					(gw as Record<string, unknown>).baseUrl,
			};
			mergedNames?.push(normalizedName);
			mergedOriginals?.set(normalizedName, name);
			api.logger?.info?.(
				`memory-hybrid: using gateway provider "${name}" for llm.providers (add ${normalizedName}/<model> to llm.default or llm.heavy to use)`,
			);
		} else {
			const gwBase =
				(gw as Record<string, unknown>).baseURL ??
				(gw as Record<string, unknown>).base_url ??
				(gw as Record<string, unknown>).baseUrl;
			const existingBase =
				typeof cur.baseURL === "string" && cur.baseURL.trim()
					? cur.baseURL
					: undefined;
			if (typeof gwBase === "string" && gwBase.trim() && !existingBase) {
				prov[targetKey] = { ...cur, baseURL: gwBase.trim() };
			}
			mergedNames?.push(normalizedName);
			mergedOriginals?.set(normalizedName, name);
		}
	}
	return newApiKeySlots;
}

function stripEmbeddingModelPrefix(model: string): string {
	const t = model.trim();
	const slash = t.indexOf("/");
	if (slash > 0 && slash < t.length - 1) return t.slice(slash + 1).trim();
	return t;
}

function mapMemorySearchProviderToEmbeddingProvider(
	providerRaw: string,
): "openai" | "google" | "ollama" | null {
	const x = providerRaw.trim().toLowerCase().replace(/_/g, "-");
	if (
		x === "openai" ||
		x === "azure-foundry" ||
		x === "azure" ||
		x === "azureopenai" ||
		x === "azure-openai"
	)
		return "openai";
	if (x === "google" || x === "gemini" || x === "vertex") return "google";
	if (x === "ollama") return "ollama";
	return null;
}

function inferEmbeddingProviderFromBareModel(
	modelBare: string,
): "openai" | "google" | "ollama" | null {
	if (OPENAI_MODELS.has(modelBare)) return "openai";
	const m = modelBare.toLowerCase();
	if (m.includes("gemini") && m.includes("embed")) return "google";
	if (
		m.includes("nomic-embed") ||
		m.includes("mxbai-embed") ||
		m === "all-minilm" ||
		m.includes("snowflake-arctic-embed")
	)
		return "ollama";
	if (m.startsWith("text-embedding") || m.startsWith("embedding-"))
		return "openai";
	return null;
}

function findGatewayProviderEntryLoose(
	gwProviders: Record<string, unknown>,
	providerHint: string,
): Record<string, unknown> | undefined {
	const hint = providerHint.trim().toLowerCase().replace(/_/g, "-");
	for (const [k, v] of Object.entries(gwProviders)) {
		if (!v || typeof v !== "object" || Array.isArray(v)) continue;
		if (k.toLowerCase().replace(/_/g, "-") === hint)
			return v as Record<string, unknown>;
	}
	return undefined;
}

/**
 * Shallow-clone plugin config branches that global inheritance mutates (issue #1002).
 */
export function shallowClonePluginConfigForGatewayMerge(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	const out = { ...raw };
	if (
		out.embedding &&
		typeof out.embedding === "object" &&
		!Array.isArray(out.embedding)
	) {
		out.embedding = { ...(out.embedding as Record<string, unknown>) };
	}
	if (out.llm && typeof out.llm === "object" && !Array.isArray(out.llm)) {
		const llm = { ...(out.llm as Record<string, unknown>) };
		if (
			llm.providers &&
			typeof llm.providers === "object" &&
			!Array.isArray(llm.providers)
		) {
			const p = { ...(llm.providers as Record<string, unknown>) };
			for (const key of Object.keys(p)) {
				const v = p[key];
				if (v && typeof v === "object" && !Array.isArray(v)) {
					p[key] = { ...(v as Record<string, unknown>) };
				}
			}
			llm.providers = p;
		}
		out.llm = llm;
	}
	return out;
}

/**
 * Before `hybridConfigSchema.parse`: merge gateway credentials into raw `llm.providers`, then
 * overlay `agents.defaults.memorySearch` onto `embedding` for omitted fields (issue #1002).
 * Plugin `embedding` / `llm.providers` entries always win when already set.
 */
export function applyGatewayEmbeddingInheritanceBeforeParse(
	raw: Record<string, unknown>,
	api: ClawdbotPluginApi,
): void {
	const gw = api.config as Record<string, unknown> | undefined;
	const gwProviders = getGatewayModelsProviders(gw);
	if (gwProviders) {
		if (!raw.llm || typeof raw.llm !== "object" || Array.isArray(raw.llm)) {
			raw.llm = { providers: {} };
		} else {
			const plm0 = raw.llm as Record<string, unknown>;
			if (
				!plm0.providers ||
				typeof plm0.providers !== "object" ||
				Array.isArray(plm0.providers)
			) {
				plm0.providers = {};
			}
		}
		const plm = raw.llm as Record<string, unknown>;
		const prov = plm.providers as Record<string, Record<string, unknown>>;
		const n = mergeGatewayProviderCredentialsIntoLlmProvidersMap(
			prov,
			gwProviders,
			api,
		);
		if (n > 0) {
			api.logger?.info?.(
				`memory-hybrid: merged ${n} gateway provider credential(s) into plugin llm.providers before config parse (issue #1002)`,
			);
		}
	}

	const agents = gw?.agents as Record<string, unknown> | undefined;
	const defaults = agents?.defaults as Record<string, unknown> | undefined;
	const ms = defaults?.memorySearch as Record<string, unknown> | undefined;
	if (!ms || ms.enabled === false) return;

	const msProvider = typeof ms.provider === "string" ? ms.provider.trim() : "";
	const msModel = typeof ms.model === "string" ? ms.model.trim() : "";
	if (!msProvider && !msModel) return;

	let emb: Record<string, unknown>;
	if (
		!raw.embedding ||
		typeof raw.embedding !== "object" ||
		Array.isArray(raw.embedding)
	) {
		emb = {};
		raw.embedding = emb;
	} else {
		emb = { ...(raw.embedding as Record<string, unknown>) };
		raw.embedding = emb;
	}

	const modelBare = msModel ? stripEmbeddingModelPrefix(msModel) : "";
	let touched = false;

	if (msModel && emb.model === undefined) {
		emb.model = modelBare;
		touched = true;
	}

	let mapped = msProvider
		? mapMemorySearchProviderToEmbeddingProvider(msProvider)
		: null;
	if (!mapped && modelBare)
		mapped = inferEmbeddingProviderFromBareModel(modelBare);
	if (mapped && emb.provider === undefined) {
		emb.provider = mapped;
		touched = true;
	}

	if (modelBare && emb.dimensions === undefined) {
		const d = EMBEDDING_DIMENSIONS[modelBare];
		if (typeof d === "number") {
			emb.dimensions = d;
			touched = true;
		}
	}

	if (gwProviders && msProvider && emb.deployment === undefined) {
		const gwp = findGatewayProviderEntryLoose(gwProviders, msProvider);
		if (gwp) {
			const dep =
				(typeof gwp.deployment === "string" && gwp.deployment.trim()) ||
				(typeof gwp.deploymentName === "string" && gwp.deploymentName.trim()) ||
				(typeof (gwp as { deploymentId?: string }).deploymentId === "string" &&
					(gwp as { deploymentId: string }).deploymentId.trim());
			if (dep) {
				emb.deployment = dep;
				touched = true;
			}
		}
	}

	const inheritedProvId =
		typeof emb.provider === "string" ? emb.provider.trim() : "";
	if (inheritedProvId && emb.apiKey === undefined) {
		const plmMerged =
			raw.llm && typeof raw.llm === "object" && !Array.isArray(raw.llm)
				? raw.llm
				: null;
		const provMerged =
			plmMerged &&
			typeof (plmMerged as Record<string, unknown>).providers === "object" &&
			!Array.isArray((plmMerged as Record<string, unknown>).providers)
				? ((plmMerged as Record<string, unknown>).providers as Record<
						string,
						unknown
					>)
				: {};
		const slot = findGatewayProviderEntryLoose(provMerged, inheritedProvId);
		const ak =
			slot && typeof slot.apiKey === "string" ? slot.apiKey.trim() : "";
		if (ak) {
			emb.apiKey = ak;
			touched = true;
		}
	}

	if (touched) {
		api.logger?.info?.(
			"memory-hybrid: inherited embedding fields from agents.defaults.memorySearch (issue #1002); plugin embedding.* still overrides when set",
		);
	}
}

/**
 * Provider prefixes that resolveClient() handles natively without explicit llm.providers config.
 * Keep in sync with the built-in provider cases in resolveClient() in this file.
 * If resolveClient() adds a new built-in provider, add it here too.
 */
export const ROUTABLE_BUILTIN_PROVIDERS = new Set([
	"google",
	"openai",
	"anthropic",
	"ollama",
	"openrouter",
	"minimax",
]);

/**
 * Extract gateway configuration from environment and plugin config.
 * Centralized to avoid duplicating this logic across buildMultiProviderOpenAI and initializeDatabases.
 */
export function extractGatewayConfig(cfg: HybridMemoryConfig): {
	gatewayPortRaw: string | undefined;
	gatewayPort: number | undefined;
	gatewayAuthResolved: string | undefined;
	gatewayToken: string | undefined;
	gatewayBaseUrl: string | undefined;
} {
	const gatewayPortRaw = normalizeResolvedSecretValue(
		getEnv("OPENCLAW_GATEWAY_PORT"),
	);
	const gatewayPort = gatewayPortRaw
		? Number.parseInt(gatewayPortRaw, 10)
		: undefined;
	const gatewayAuthResolved = (
		cfg.gateway?.auth as ResolvedGatewayAuthConfig | undefined
	)?._resolvedToken;
	const gatewayToken =
		gatewayAuthResolved ??
		normalizeResolvedSecretValue(getEnv("OPENCLAW_GATEWAY_TOKEN"));
	const gatewayBaseUrl =
		gatewayPort && gatewayPort >= 1 && gatewayPort <= 65535
			? `http://127.0.0.1:${gatewayPort}/v1`
			: undefined;
	return {
		gatewayPortRaw,
		gatewayPort,
		gatewayAuthResolved,
		gatewayToken,
		gatewayBaseUrl,
	};
}

/** Known provider OpenAI-compatible base URLs. */
const GOOGLE_GEMINI_BASE_URL =
	"https://generativelanguage.googleapis.com/v1beta/openai/";
/** Default Ollama server base URL (without /v1 path). */
export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
/** How long to cache an Ollama health-check result (positive or negative). */
const OLLAMA_HEALTH_CACHE_TTL_MS = 30_000;
/** Timeout for a single Ollama /api/tags health ping. */
const OLLAMA_HEALTH_TIMEOUT_MS = 2_000;

/**
 * Module-level health cache so repeated calls within the TTL window skip the network round-trip.
 * Shared across plugin reloads in the same process (intentional).
 */
const _ollamaHealthCache = new Map<string, { ok: boolean; ts: number }>();

/**
 * Probe an Ollama server via GET /api/tags (the Ollama health endpoint).
 * Returns true when Ollama is reachable and responsive, false otherwise.
 * Results are cached for OLLAMA_HEALTH_CACHE_TTL_MS to avoid hammering the endpoint.
 */
export async function probeOllamaEndpoint(baseUrl: string): Promise<boolean> {
	const now = Date.now();
	const cached = _ollamaHealthCache.get(baseUrl);
	if (cached && now - cached.ts < OLLAMA_HEALTH_CACHE_TTL_MS) return cached.ok;
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		OLLAMA_HEALTH_TIMEOUT_MS,
	);
	try {
		const resp = await fetch(`${baseUrl}/api/tags`, {
			signal: controller.signal,
		});
		const ok = resp.ok;
		_ollamaHealthCache.set(baseUrl, { ok, ts: now });
		return ok;
	} catch {
		_ollamaHealthCache.set(baseUrl, { ok: false, ts: now });
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

/** Invalidate cached Ollama health result (e.g. after auto-start). */
export function clearOllamaHealthCacheEntry(baseUrl: string): void {
	_ollamaHealthCache.delete(baseUrl);
}

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION_HEADER = "2023-06-01";

/** Built-in OpenAI-compatible base URL for MiniMax API (global endpoint). */
export const MINIMAX_BASE_URL = "https://api.minimax.io/v1";

/**
 * Canonical MiniMax model name mapping (lowercase key → proper-case value).
 * Covers Ollama-style aliases (e.g. "minimax-m2.5:cloud") that users may configure
 * and that would otherwise produce a 404 from the MiniMax API (issue #400).
 */
const MINIMAX_MODEL_ALIASES: Record<string, string> = {
	"minimax-m2.5": "MiniMax-M2.5",
	"minimax-text-01": "MiniMax-Text-01",
};

/**
 * Canonicalize a bare MiniMax model name.
 * - Strips Ollama-style `:tag` suffixes (e.g. `:cloud`, `:latest`) which are invalid on the MiniMax API.
 * - Looks up the result in MINIMAX_MODEL_ALIASES to restore correct casing (e.g. "minimax-m2.5" → "MiniMax-M2.5").
 * - Falls back to the original bare name (without tag) if no alias matches.
 */
function canonicalizeMiniMaxModelId(bare: string): string {
	// Strip Ollama-style ":tag" suffix (e.g. "minimax-m2.5:cloud" → "minimax-m2.5")
	const withoutTag = bare.includes(":")
		? bare.slice(0, bare.indexOf(":"))
		: bare;
	const canonical = MINIMAX_MODEL_ALIASES[withoutTag.toLowerCase()];
	return canonical ?? withoutTag;
}

/** OpenRouter OpenAI-compatible base URL. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Resolved API key with metadata about which configuration source provided it. */
type ResolvedApiKey = { value?: string; source: string };

/**
 * Centralised API-key resolver for all built-in and custom providers.
 *
 * Resolves the API key for a named provider using a well-defined precedence chain.
 * Provider-specific exceptions are explicit and documented here, rather than scattered
 * across individual provider branches in `resolveClient`.
 *
 * Precedence table (highest → lowest):
 *
 * | Source                      | google | openai | anthropic | openrouter | minimax | ollama | custom |
 * |-----------------------------|:------:|:------:|:---------:|:----------:|:-------:|:------:|:------:|
 * | llm.providers.X.apiKey      |   ✓    |   ✓    |     ✓     |     ✓      |    ✓    |   ✓    |   ✓    |
 * | distill.apiKey (legacy)     |   ✓    |        |           |            |         |        |        |
 * | gatewayToken                |        |   ✓†   |           |            |         |        |        |
 * | embedding.apiKey            |        |   ✓†   |           |            |         |        |        |
 * | GOOGLE_API_KEY env          |   ✓    |        |           |            |         |        |        |
 * | OPENAI_API_KEY env          |        |   ✓*   |           |            |         |        |        |
 * | AZURE_OPENAI_API_KEY env    |        |        |           |            |         |        |   ✓‡   |
 * | ANTHROPIC_API_KEY env       |        |        |     ✓     |            |         |        |        |
 * | OPENROUTER_API_KEY env      |        |        |           |     ✓      |         |        |        |
 * | MINIMAX_API_KEY env         |        |        |           |            |    ✓    |        |        |
 * | <PREFIX>_API_KEY env        |        |        |           |            |         |        |   ✓    |
 * | "ollama" (no-op default)    |        |        |           |            |         |   ✓    |        |
 *
 * * openai: OPENAI_API_KEY is preferred over embedding.apiKey so Azure and OpenAI keys do not conflict.
 * † openai: `gatewayToken` and `embedding.apiKey` are skipped when `hasCustomExternalBaseURL` is true
 *   (security: never send internal gateway credentials to external endpoints).
 * ‡ azure-foundry / azure-foundry-responses: AZURE_OPENAI_API_KEY env when llm.providers.*.apiKey not set.
 *
 * @param prefix                       Lowercase provider prefix, e.g. "google", "openai".
 * @param providerCfg                  The llm.providers[prefix] config object, if present.
 * @param cfg                          Full plugin config.
 * @param resolveKey                   SecretRef resolver (env:VAR / file:// / ${VAR}).
 * @param opts.gatewayToken            Resolved gateway auth token (openai only).
 * @param opts.hasCustomExternalBaseURL  True when openai uses a non-gateway baseURL.
 * @param opts.env                     Process environment (injectable for tests; defaults to process.env).
 */
export function resolveProviderApiKey(
	prefix: string,
	providerCfg: LLMProviderConfig | undefined,
	cfg: HybridMemoryConfig,
	resolveKey: (key: string | undefined) => string | undefined,
	opts: {
		gatewayToken?: string;
		hasCustomExternalBaseURL?: boolean;
		env?: NodeJS.ProcessEnv;
	} = {},
): ResolvedApiKey {
	const {
		gatewayToken,
		hasCustomExternalBaseURL = false,
		env = process.env,
	} = opts;
	const readEnvKey = (name: string): string | undefined =>
		normalizeResolvedSecretValue(env[name]);

	// Highest priority: explicit per-provider key in llm.providers config (all providers).
	const fromProviderCfg = resolveKey(providerCfg?.apiKey);
	if (fromProviderCfg)
		return { value: fromProviderCfg, source: `llm.providers.${prefix}.apiKey` };

	if (prefix === "google") {
		// Legacy fallback: distill.apiKey doubles as the Google API key for distillation.
		const fromDistill = resolveKey(cfg.distill?.apiKey);
		if (fromDistill) return { value: fromDistill, source: "distill.apiKey" };
		const fromEnv = readEnvKey("GOOGLE_API_KEY");
		if (fromEnv) return { value: fromEnv, source: "GOOGLE_API_KEY" };
		return { source: "none" };
	}

	if (prefix === "openai") {
		// Prefer OPENAI_API_KEY over embedding.apiKey so Azure (embedding) and OpenAI (chat) can use different keys.
		const fromEnv = readEnvKey("OPENAI_API_KEY");
		if (fromEnv) return { value: fromEnv, source: "OPENAI_API_KEY" };
		// Security: never send gateway/embedding credentials to an arbitrary external endpoint.
		if (!hasCustomExternalBaseURL) {
			if (gatewayToken) return { value: gatewayToken, source: "gatewayToken" };
			const fromEmbedding = resolveKey(cfg.embedding?.apiKey);
			if (fromEmbedding)
				return { value: fromEmbedding, source: "embedding.apiKey" };
		}
		return { source: "none" };
	}

	// Azure Foundry (and Responses) use AZURE_OPENAI_API_KEY so it does not conflict with OPENAI_API_KEY.
	if (prefix === "azure-foundry" || prefix === "azure-foundry-responses") {
		const fromEnv = readEnvKey("AZURE_OPENAI_API_KEY");
		if (fromEnv) return { value: fromEnv, source: "AZURE_OPENAI_API_KEY" };
		return { source: "none" };
	}

	if (prefix === "anthropic") {
		const fromEnv = readEnvKey("ANTHROPIC_API_KEY");
		if (fromEnv) return { value: fromEnv, source: "ANTHROPIC_API_KEY" };
		return { source: "none" };
	}

	if (prefix === "openrouter") {
		const fromEnv = readEnvKey("OPENROUTER_API_KEY");
		if (fromEnv) return { value: fromEnv, source: "OPENROUTER_API_KEY" };
		return { source: "none" };
	}

	if (prefix === "minimax") {
		const fromEnv = readEnvKey("MINIMAX_API_KEY");
		if (fromEnv) return { value: fromEnv, source: "MINIMAX_API_KEY" };
		return { source: "none" };
	}

	if (prefix === "ollama") {
		// Ollama's OpenAI-compatible endpoint accepts any non-empty string as the API key.
		return { value: "ollama", source: "default" };
	}

	// Generic env fallback: <PREFIX>_API_KEY (covers any provider following this convention).
	// NOTE: the gateway token is intentionally excluded — it is scoped to the local gateway
	// and must never be sent to arbitrary external endpoints.
	const fromGenericEnv = readEnvKey(`${prefix.toUpperCase()}_API_KEY`);
	if (fromGenericEnv)
		return { value: fromGenericEnv, source: `${prefix.toUpperCase()}_API_KEY` };

	return { source: "none" };
}

/**
 * Builds a multi-provider OpenAI-compatible proxy that routes each model to the correct provider API.
 * All existing call sites use `openai.chat.completions.create({ model, ... })` unchanged — this
 * proxy intercepts those calls and selects the right API endpoint + key based on the model prefix.
 *
 * Routing:
 *  - `google/*`  → Google Gemini OpenAI-compat endpoint (distill.apiKey or llm.providers.google.apiKey)
 *  - `openai/*` or bare model (no `/`) → OpenAI (embedding.apiKey or llm.providers.openai.apiKey)
 *  - `ollama/*` → local Ollama server (http://127.0.0.1:11434/v1, or llm.providers.ollama.baseURL)
 *  - Other `provider/*` with explicit llm.providers config → custom endpoint
 *  - Unknown provider, no config → throws UnconfiguredProviderError
 */
export function buildMultiProviderOpenAI(
	cfg: HybridMemoryConfig,
	api: ClawdbotPluginApi,
	costTracker: CostTracker | null,
	authBackoffStatePath?: string,
): OpenAI {
	const clientCache = new Map<string, OpenAI>();
	/** Resolve env:VAR / file:/path / ${VAR} SecretRef strings so all llm.providers keys work with SecretRef format (Issue #344).
	 *  Delegates to the shared resolveSecretRef helper from config/parsers/core.ts to avoid duplicated logic. */
	const resolveApiKey = (key: string | undefined): string | undefined => {
		// Reject undefined, null, and whitespace-only strings before reaching resolveSecretRef (issues #10, #11).
		if (!key?.trim()) return undefined;
		return resolveSecretRef(key);
	};
	const {
		gatewayPortRaw,
		gatewayPort,
		gatewayAuthResolved,
		gatewayToken,
		gatewayBaseUrl,
	} = extractGatewayConfig(cfg);
	// Fail closed: if gateway.auth.token is configured but cannot be resolved, throw rather than
	// silently falling back to OPENCLAW_GATEWAY_TOKEN — a stale env token would mask rollout mistakes.
	if (cfg.gateway?.auth?.token && !gatewayAuthResolved) {
		throw new Error(
			`memory-hybrid: gateway.auth.token is configured (SecretRef "${cfg.gateway.auth.token}") but could not be resolved. Ensure the referenced env var or file is accessible, or remove gateway.auth.token from the plugin config. Not falling back to OPENCLAW_GATEWAY_TOKEN to prevent silent auth misconfiguration.`,
		);
	}
	if (
		gatewayPortRaw &&
		(!gatewayPort || gatewayPort < 1 || gatewayPort > 65535)
	) {
		api.logger.warn?.(
			`memory-hybrid: OPENCLAW_GATEWAY_PORT must be 1-65535 (got '${gatewayPortRaw}'); falling back to direct OpenAI.`,
		);
	}
	if (gatewayBaseUrl && !gatewayToken) {
		api.logger.warn?.(
			"memory-hybrid: OPENCLAW_GATEWAY_PORT set but no gateway auth token found; set gateway.auth.token (SecretRef) in plugin config or OPENCLAW_GATEWAY_TOKEN env var. Gateway calls may fail if auth is required.",
		);
	}

	function getOrCreate(key: string, factory: () => OpenAI): OpenAI {
		if (!clientCache.has(key)) clientCache.set(key, factory());
		return clientCache.get(key)!;
	}

	function defaultOpenAIClient(): OpenAI {
		if (gatewayBaseUrl) {
			const key = gatewayToken ?? cfg.embedding.apiKey;
			if (!key) throw new UnconfiguredProviderError("openai", "openai/*");
			return getOrCreate(
				`openai:gateway:${gatewayBaseUrl}`,
				() =>
					new OpenAI({
						apiKey: key,
						baseURL: gatewayBaseUrl,
					}),
			);
		}
		if (!cfg.embedding.apiKey)
			throw new UnconfiguredProviderError("openai", "openai/*");
		return getOrCreate(
			"openai:default",
			() => new OpenAI({ apiKey: cfg.embedding.apiKey! }),
		);
	}

	/**
	 * Normalize bare model names (no "provider/" prefix) to "provider/model" so the correct API is used.
	 * OpenClaw and some configs use bare names (e.g. gemini-3.1-pro-preview); without the prefix we
	 * would route to the default OpenAI client and get 404.
	 */
	function normalizeModelId(model: string): string {
		const trimmed = model.trim();
		if (trimmed.includes("/")) return trimmed;
		const lower = trimmed.toLowerCase();
		if (lower.startsWith("gemini-")) return `google/${trimmed}`;
		if (lower.startsWith("claude-")) return `anthropic/${trimmed}`;
		if (lower.startsWith("gpt-") || /^o[0-9]+/.test(lower))
			return `openai/${trimmed}`;
		if (lower.startsWith("minimax-"))
			return `minimax/${canonicalizeMiniMaxModelId(trimmed)}`;
		return trimmed;
	}

	/**
	 * Canonicalize model id for cost logging so pricing table lookup and reports use the correct provider.
	 * Gateways may pass e.g. openai/gemini-3.1-pro-preview; we store google/gemini-3.1-pro-preview.
	 */
	function canonicalModelIdForCost(providerSlashModel: string): string {
		const trimmed = providerSlashModel.trim();
		const slashIdx = trimmed.indexOf("/");
		const bare = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
		const lower = bare.toLowerCase();
		if (lower.startsWith("gemini-")) return `google/${bare}`;
		if (lower.startsWith("claude-")) return `anthropic/${bare}`;
		if (lower.startsWith("gpt-") || /^o[0-9]+/.test(lower))
			return `openai/${bare}`;
		if (lower.startsWith("minimax-"))
			return `minimax/${canonicalizeMiniMaxModelId(bare)}`;
		return trimmed.includes("/") ? trimmed : `openai/${trimmed}`;
	}

	/** The configured auth.order map from plugin config (issue #311). */
	const authOrder = cfg.auth?.order;
	const preferOAuthWhenBoth = cfg.auth?.preferOAuthWhenBoth !== false;
	const failoverOpts = authBackoffStatePath
		? {
				statePath: authBackoffStatePath,
				backoffScheduleMinutes: cfg.auth?.backoffScheduleMinutes?.length
					? cfg.auth.backoffScheduleMinutes
					: DEFAULT_BACKOFF_MINUTES,
				resetBackoffAfterHours:
					cfg.auth?.resetBackoffAfterHours ?? DEFAULT_RESET_AFTER_HOURS,
			}
		: undefined;

	function hasApiKeyForProvider(prefix: string): boolean {
		const providerCfg: LLMProviderConfig | undefined = (
			cfg.llm?.providers as
				| Record<string, LLMProviderConfig | undefined>
				| undefined
		)?.[prefix];
		const hasCustomExternalBaseURL =
			prefix === "openai" &&
			Boolean(providerCfg?.baseURL && providerCfg.baseURL !== gatewayBaseUrl);
		// Exclude gatewayToken from the check for OAuth routing decisions — we only want to detect
		// a real direct API key (llm.providers.X.apiKey, embedding.apiKey, or env var).
		const { value } = resolveProviderApiKey(
			prefix,
			providerCfg,
			cfg,
			resolveApiKey,
			{
				gatewayToken: undefined,
				hasCustomExternalBaseURL,
			},
		);
		return Boolean(value && value.length >= 10);
	}

	function resolveClient(model: string): {
		client: OpenAI;
		bareModel: string;
		ollamaBaseUrl?: string;
		useFullModel?: boolean;
		authType?: "oauth";
	} {
		const normalized = normalizeModelId(model);
		const trimmed = normalized.trim();
		const slashIdx = trimmed.indexOf("/");

		if (slashIdx <= 0) {
			return { client: defaultOpenAIClient(), bareModel: trimmed };
		}

		const prefix = trimmed.slice(0, slashIdx).toLowerCase();
		const bareModel = trimmed.slice(slashIdx + 1);
		const providerCfg: LLMProviderConfig | undefined = (
			cfg.llm?.providers as
				| Record<string, LLMProviderConfig | undefined>
				| undefined
		)?.[prefix];

		// OAuth + optional failover: when both OAuth and API key exist, prefer OAuth unless in backoff.
		if (
			hasOAuthProfiles(authOrder?.[prefix], prefix) &&
			gatewayBaseUrl &&
			gatewayToken
		) {
			const hasApi = hasApiKeyForProvider(prefix);
			const useOAuth =
				!hasApi ||
				(preferOAuthWhenBoth &&
					(!failoverOpts || !isOAuthInBackoff(prefix, failoverOpts)));
			if (useOAuth) {
				return {
					client: getOrCreate(
						`gateway:oauth:${gatewayBaseUrl}:${prefix}`,
						() => new OpenAI({ apiKey: gatewayToken, baseURL: gatewayBaseUrl }),
					),
					bareModel,
					useFullModel: true,
					authType: "oauth",
				};
			}
			// Fall through to use API client (OAuth in backoff or preferOAuthWhenBoth false).
		}

		if (prefix === "google") {
			const { value: apiKey } = resolveProviderApiKey(
				"google",
				providerCfg,
				cfg,
				resolveApiKey,
			);
			if (!apiKey) throw new UnconfiguredProviderError("google", trimmed);
			const baseURL = providerCfg?.baseURL ?? GOOGLE_GEMINI_BASE_URL;
			return {
				client: getOrCreate(
					`google:${baseURL}`,
					() => new OpenAI({ apiKey, baseURL }),
				),
				bareModel,
			};
		}

		if (prefix === "openai") {
			// Only use the gateway token when routing through the local gateway.
			// If a custom external baseURL is configured for the openai provider,
			// do NOT fall back to gatewayToken — that would send the internal gateway
			// token to an arbitrary external endpoint (security issue).
			const hasCustomExternalBaseURL = Boolean(
				providerCfg?.baseURL && providerCfg.baseURL !== gatewayBaseUrl,
			);
			const { value: apiKey } = resolveProviderApiKey(
				"openai",
				providerCfg,
				cfg,
				resolveApiKey,
				{
					gatewayToken,
					hasCustomExternalBaseURL,
				},
			);
			if (!apiKey) throw new UnconfiguredProviderError("openai", trimmed);
			const baseURL = providerCfg?.baseURL ?? gatewayBaseUrl;
			const cacheKey = `openai:prefixed:${apiKey.slice(0, 8)}:${baseURL ?? "default"}`;
			return {
				client: getOrCreate(
					cacheKey,
					() => new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) }),
				),
				bareModel,
			};
		}

		if (prefix === "anthropic") {
			const { value: apiKey } = resolveProviderApiKey(
				"anthropic",
				providerCfg,
				cfg,
				resolveApiKey,
			);
			if (!apiKey) throw new UnconfiguredProviderError("anthropic", trimmed);
			let baseURL = providerCfg?.baseURL ?? ANTHROPIC_BASE_URL;
			// Normalize: ensure Anthropic baseURL ends with /v1 for OpenAI-compatible chat endpoint (issue #950)
			baseURL = baseURL.replace(/\/+$/, "");
			if (!baseURL.endsWith("/v1")) {
				baseURL = `${baseURL}/v1`;
			}
			// Anthropic's OpenAI-compatible endpoints require anthropic-version header
			return {
				client: getOrCreate(
					`anthropic:${baseURL}`,
					() =>
						new OpenAI({
							apiKey,
							baseURL,
							defaultHeaders: { "anthropic-version": ANTHROPIC_VERSION_HEADER },
						}),
				),
				bareModel,
			};
		}

		if (prefix === "ollama") {
			// Ollama exposes an OpenAI-compatible API at /v1. No real API key is required.
			let baseURL = providerCfg?.baseURL ?? `${OLLAMA_DEFAULT_BASE_URL}/v1`;
			// Ensure baseURL ends with /v1 for OpenAI client
			if (!/\/v1\/?$/.test(baseURL)) {
				baseURL = `${baseURL.replace(/\/$/, "")}/v1`;
			}
			// Strip /v1 suffix for the health-check base URL
			const ollamaBaseUrl = baseURL.replace(/\/v1\/?$/, "");
			const { value: apiKey } = resolveProviderApiKey(
				"ollama",
				providerCfg,
				cfg,
				resolveApiKey,
			);
			const cacheKey = `ollama:${baseURL}`;
			return {
				client: getOrCreate(
					cacheKey,
					() => new OpenAI({ apiKey: apiKey ?? "ollama", baseURL }),
				),
				bareModel,
				ollamaBaseUrl,
			};
		}

		if (prefix === "openrouter") {
			// OpenRouter exposes an OpenAI-compatible API at https://openrouter.ai/api/v1.
			// Model names are passed as-is after stripping the "openrouter/" prefix
			// (e.g. "openrouter/anthropic/claude-3.5-sonnet" → bareModel "anthropic/claude-3.5-sonnet").
			const { value: apiKey } = resolveProviderApiKey(
				"openrouter",
				providerCfg,
				cfg,
				resolveApiKey,
			);
			if (!apiKey) throw new UnconfiguredProviderError("openrouter", trimmed);
			const baseURL = providerCfg?.baseURL ?? OPENROUTER_BASE_URL;
			// Include apiKey prefix in cache key so key rotation takes effect without restart.
			// defaultHeaders follow OpenRouter's recommendations for attribution and rate-limit priority.
			const cacheKey = `openrouter:${baseURL}:${apiKey.slice(0, 8)}`;
			return {
				client: getOrCreate(
					cacheKey,
					() =>
						new OpenAI({
							apiKey,
							baseURL,
							defaultHeaders: {
								"HTTP-Referer":
									"https://github.com/markus-lassfolk/openclaw-hybrid-memory",
								"X-Title": "openclaw-hybrid-memory",
							},
						}),
				),
				bareModel,
			};
		}

		if (prefix === "minimax") {
			// Use the built-in MiniMax API endpoint as default so callers never accidentally
			// fall through to the default OpenAI client (which returns 404 for MiniMax models).
			const { value: apiKey } = resolveProviderApiKey(
				"minimax",
				providerCfg,
				cfg,
				resolveApiKey,
			);
			if (!apiKey) throw new UnconfiguredProviderError("minimax", trimmed);
			const baseURL = providerCfg?.baseURL ?? MINIMAX_BASE_URL;
			// Canonicalize the bare model name: strip Ollama-style ":tag" suffixes and fix casing
			// so that e.g. "minimax-m2.5:cloud" → "MiniMax-M2.5" (issue #400).
			const canonicalBareModel = canonicalizeMiniMaxModelId(bareModel);
			return {
				client: getOrCreate(
					`minimax:${baseURL}`,
					() => new OpenAI({ apiKey, baseURL }),
				),
				bareModel: canonicalBareModel,
			};
		}

		// For all remaining providers (custom configs and unknown providers), use the centralised
		// resolver which covers llm.providers[prefix].apiKey and the <PREFIX>_API_KEY env convention.
		// The gateway token is intentionally excluded — it is scoped to the local gateway and must
		// never be sent to arbitrary external endpoints.
		const { value: resolvedApiKey } = resolveProviderApiKey(
			prefix,
			providerCfg,
			cfg,
			resolveApiKey,
		);
		if (readProviderBaseUrl(providerCfg) || resolvedApiKey) {
			// apiKey may be absent when the provider only needs a custom baseURL (some self-hosted servers)
			const apiKey = resolvedApiKey ?? "no-key";
			const baseURL = readProviderBaseUrl(providerCfg);
			// Azure OpenAI / Foundry resource hosts: api-key header (SDK still adds Bearer; many endpoints accept both).
			const isAzureResource =
				typeof baseURL === "string" && isAzureOpenAiResourceEndpoint(baseURL);
			// Azure API Management (*.azure-api.net): must strip Bearer — use same fetch as embeddings factory.
			const isApim =
				typeof baseURL === "string" && isAzureApiManagementGatewayUrl(baseURL);
			const clientOpts: {
				apiKey: string;
				baseURL?: string;
				defaultHeaders?: Record<string, string>;
				fetch?: typeof globalThis.fetch;
			} = {
				apiKey,
				...(baseURL ? { baseURL } : {}),
			};
			if (apiKey !== "no-key") {
				if (isAzureResource) clientOpts.defaultHeaders = { "api-key": apiKey };
				if (isApim) {
					clientOpts.defaultHeaders = {
						...(clientOpts.defaultHeaders ?? {}),
						"api-key": apiKey,
					};
					clientOpts.fetch = createApimGatewayFetch(apiKey);
				}
			}
			const cacheKey = `custom:${prefix}:${apiKey.slice(0, 8)}:${baseURL ?? "default"}`;
			return {
				client: getOrCreate(cacheKey, () => new OpenAI(clientOpts)),
				bareModel,
			};
		}

		// Unknown provider with no config — throw so callers can skip to the next model cleanly
		throw new UnconfiguredProviderError(prefix, trimmed);
	}

	/**
	 * Newer OpenAI models (o-series, gpt-5+, gpt-4.1*) use `max_completion_tokens` instead of `max_tokens`.
	 * Reasoning models (o1, o3, o4-*) also reject temperature/top_p — strip those params.
	 * Applied for every routed provider (Azure Foundry, etc.), not only `openai/` — see model-capabilities.
	 */
	function remapMaxTokensForOpenAI(
		body: Record<string, unknown>,
	): Record<string, unknown> {
		let result = body;
		const modelId = String(result.model ?? "");
		if (
			requiresMaxCompletionTokens(modelId) &&
			"max_tokens" in result &&
			!("max_completion_tokens" in result)
		) {
			const { max_tokens, ...rest } = result;
			result = { ...rest, max_completion_tokens: max_tokens };
		}
		if (isReasoningModel(modelId)) {
			// Reasoning models only accept temperature=1 (the default); strip to avoid 400
			const { temperature, top_p, ...rest } = result as Record<
				string,
				unknown
			> & {
				temperature?: unknown;
				top_p?: unknown;
			};
			if (temperature !== undefined || top_p !== undefined) {
				api.logger.debug?.(
					`memory-hybrid: stripped temperature/top_p for reasoning model ${modelId}`,
				);
			}
			result = rest;
		}
		return result;
	}

	/**
	 * Shared cost-tracking wrapper for both chat and responses calls.
	 * Fire-and-forget — never blocks or modifies the returned promise.
	 */
	function trackCost(
		promise: Promise<unknown>,
		body: Record<string, unknown>,
		model: string,
		start: number,
	): void {
		if (!costTracker) return;
		const feature = inferFeatureLabel(body, model);
		const normalizedModel = canonicalModelIdForCost(
			model.includes("/") ? model : `openai/${model.trim()}`,
		);
		void Promise.resolve(promise).then(
			(resp: unknown) => {
				try {
					const durationMs = Date.now() - start;
					const r = resp as {
						usage?: {
							prompt_tokens?: number;
							completion_tokens?: number;
							input_tokens?: number;
							output_tokens?: number;
						};
					} | null;
					costTracker.record({
						feature,
						model: normalizedModel,
						inputTokens: r?.usage?.prompt_tokens ?? r?.usage?.input_tokens ?? 0,
						outputTokens:
							r?.usage?.completion_tokens ?? r?.usage?.output_tokens ?? 0,
						durationMs,
						success: true,
					});
				} catch {
					/* never let tracking break LLM calls */
				}
			},
			() => {
				try {
					const durationMs = Date.now() - start;
					const reqMessages = Array.isArray(body.messages)
						? (body.messages as unknown[])
						: [];
					const reqInput = Array.isArray(body.input)
						? (body.input as unknown[])
						: [];
					const content = reqMessages.length > 0 ? reqMessages : reqInput;
					const estimatedInputTokens = Math.ceil(
						JSON.stringify(content).length / 4,
					);
					costTracker.record({
						feature,
						model: normalizedModel,
						inputTokens: estimatedInputTokens,
						outputTokens: 0,
						durationMs,
						success: false,
					});
				} catch {
					/* never let tracking break LLM calls */
				}
			},
		);
	}

	// Proxy that intercepts chat.completions.create and responses.create, routing to the right provider client.
	// All other OpenAI methods (embeddings, etc.) are NOT proxied — embeddings use a separate client.
	// The proxy base is only accessed for non-chat methods (not used by this plugin directly).
	// Only create it with a real key when one is available; otherwise omit to avoid "unused" placeholder.
	const proxyBaseKey = cfg.embedding.apiKey ?? gatewayToken ?? "";
	const proxyBase: OpenAI = proxyBaseKey
		? new OpenAI({ apiKey: proxyBaseKey })
		: ({} as OpenAI);
	return new Proxy(proxyBase, {
		get(target, prop, receiver) {
			if (prop === "chat") {
				return {
					completions: {
						create(
							body: Parameters<OpenAI["chat"]["completions"]["create"]>[0],
							opts?: Parameters<OpenAI["chat"]["completions"]["create"]>[1],
						) {
							const rawModel: string = (body as { model?: string }).model ?? "";
							const model = normalizeModelId(rawModel);
							const {
								client,
								bareModel,
								ollamaBaseUrl,
								useFullModel,
								authType,
							} = resolveClient(model);
							const prefix = model.trim().split("/")[0]?.toLowerCase();
							// When gateway-routed for non-OpenAI providers (auth.order OAuth), send the full "provider/model"
							// name so the gateway can route to the correct provider using the configured auth profile.
							const modelForRequest = useFullModel ? model.trim() : bareModel;
							const merged = {
								...(body as object),
								model: modelForRequest,
							} as Record<string, unknown>;
							const adjustedBody = remapMaxTokensForOpenAI(merged);
							const start = Date.now();

							// Responses-only models: route chat.completions.create → responses.create so direct SDK
							// call sites (classification, auto-classifier, etc.) work with azure-foundry-responses/* (#1043, Codex P1).
							if (resolveWireApi(model) === "responses") {
								if ((adjustedBody as { stream?: boolean }).stream) {
									return Promise.reject(
										new Error(
											"memory-hybrid: stream=true is not supported for Responses API models (e.g. azure-foundry-responses/*); set stream: false.",
										),
									);
								}
								const responsesBody =
									buildResponsesRequestFromChatBody(adjustedBody);
								const input = responsesBody.input;
								if (!Array.isArray(input) || input.length === 0) {
									return Promise.reject(
										new Error(
											"memory-hybrid: Responses API request requires non-empty messages",
										),
									);
								}
								const responsesNs = (
									client as unknown as {
										responses?: {
											create: (b: unknown, o?: unknown) => Promise<unknown>;
										};
									}
								).responses;
								if (!responsesNs?.create) {
									return Promise.reject(
										new Error(
											`Provider "${prefix}" does not expose responses.create(). Ensure the endpoint supports the OpenAI Responses API and the openai SDK is >=6.16.0.`,
										),
									);
								}
								const modelLabel = String(
									adjustedBody.model ?? modelForRequest,
								);
								let promise: Promise<unknown> = responsesNs.create(
									responsesBody,
									opts ?? {},
								);
								if (authType === "oauth" && failoverOpts) {
									promise = promise.catch((err: unknown) => {
										recordOAuthFailure(prefix, failoverOpts);
										throw err;
									});
								}
								promise = promise.then((raw) =>
									responsesRawToChatCompletion(
										raw as ResponsesApiResponse,
										modelLabel,
									),
								);
								trackCost(
									promise,
									body as unknown as Record<string, unknown>,
									model,
									start,
								);
								return promise as ReturnType<
									OpenAI["chat"]["completions"]["create"]
								>;
							}

							// For Ollama models, probe the local server before attempting the call so we fall
							// through to the next tier model quickly instead of waiting for a TCP timeout.
							const makeCall = () =>
								client.chat.completions.create(
									adjustedBody as unknown as Parameters<
										OpenAI["chat"]["completions"]["create"]
									>[0],
									opts,
								);
							let promise: ReturnType<typeof makeCall> = ollamaBaseUrl
								? ((async () => {
										const available = await probeOllamaEndpoint(ollamaBaseUrl);
										if (!available) {
											const err = Object.assign(
												new Error(
													`Ollama not available at ${ollamaBaseUrl} (ECONNREFUSED) — try next model`,
												),
												{ code: "ECONNREFUSED" },
											);
											throw err;
										}
										return makeCall();
									})() as ReturnType<typeof makeCall>)
								: makeCall();
							if (authType === "oauth" && failoverOpts) {
								promise = promise.catch((err: unknown) => {
									recordOAuthFailure(prefix, failoverOpts);
									throw err;
								}) as ReturnType<typeof makeCall>;
							}
							trackCost(
								promise as Promise<unknown>,
								body as unknown as Record<string, unknown>,
								model,
								start,
							);
							return promise;
						},
					},
				};
			}

			if (prop === "responses") {
				return {
					create(
						body: Record<string, unknown>,
						opts?: { signal?: AbortSignal },
					) {
						const rawModel: string = String(body.model ?? "");
						const model = normalizeModelId(rawModel);
						const { client, bareModel, useFullModel, authType } =
							resolveClient(model);
						const prefix = model.trim().split("/")[0]?.toLowerCase();
						const modelForRequest = useFullModel ? model.trim() : bareModel;
						const merged = { ...body, model: modelForRequest };
						const adjustedBody = remapMaxTokensForOpenAI(merged);
						const start = Date.now();

						const responsesNs = (
							client as unknown as {
								responses?: {
									create: (b: unknown, o?: unknown) => Promise<unknown>;
								};
							}
						).responses;
						if (!responsesNs?.create) {
							return Promise.reject(
								new Error(
									`Provider "${prefix}" does not expose responses.create(). Ensure the endpoint supports the OpenAI Responses API and the openai SDK is >=6.16.0.`,
								),
							);
						}

						let promise = responsesNs.create(adjustedBody, opts ?? {});
						if (authType === "oauth" && failoverOpts) {
							promise = promise.catch((err: unknown) => {
								recordOAuthFailure(prefix, failoverOpts);
								throw err;
							});
						}
						trackCost(promise, body, model, start);
						return promise;
					},
				};
			}

			return Reflect.get(target, prop, receiver);
		},
	}) as OpenAI;
}
