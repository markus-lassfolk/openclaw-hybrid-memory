import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { FactsDB } from "../backends/facts-db.js";
import type { IdentityReflectionStore } from "../backends/identity-reflection-store.js";
import type { ScopeFilter } from "../types/memory.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { LLMRetryError, chatCompleteWithRetry } from "./chat.js";
import { CostFeature } from "./cost-feature-labels.js";
import { capturePluginError } from "./error-reporter.js";

interface IdentityReflectionQuestion {
	key: string;
	prompt: string;
}

export const DEFAULT_IDENTITY_REFLECTION_QUESTIONS: IdentityReflectionQuestion[] =
	[
		{ key: "protect", prompt: "What do I reliably protect?" },
		{
			key: "speak_silence",
			prompt: "When should I speak, and when should I stay silent?",
		},
		{
			key: "partnership",
			prompt: "What patterns define good partnership with the user?",
		},
		{ key: "tradeoffs", prompt: "What kinds of tradeoffs do I keep making?" },
		{ key: "durability", prompt: "Which insights feel temporary vs durable?" },
	];

interface IdentityReflectionConfig {
	enabled: boolean;
	model?: string;
	defaultWindow: number;
	minInsights: number;
	maxInsightsPerRun: number;
	questions: IdentityReflectionQuestion[];
}

interface IdentityReflectionOptions {
	dryRun: boolean;
	model: string;
	window?: number;
	verbose?: boolean;
	fallbackModels?: string[];
	scopeFilter?: ScopeFilter;
}

interface ParsedIdentityItem {
	questionKey: string;
	insight: string;
	durability: "durable" | "temporary";
	confidence: number;
	evidence: string[];
}

interface IdentityReflectionResult {
	insightsExtracted: number;
	insightsStored: number;
	questionsAsked: number;
}

function normalizeForDedupe(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseIdentityReflectionResponse(raw: string): ParsedIdentityItem[] {
	const firstBracket = raw.indexOf("[");
	const lastBracket = raw.lastIndexOf("]");
	const json =
		firstBracket !== -1 && lastBracket !== -1 && lastBracket >= firstBracket
			? raw.slice(firstBracket, lastBracket + 1)
			: raw;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: ParsedIdentityItem[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") continue;
		const obj = item as Record<string, unknown>;
		const questionKey =
			typeof obj.questionKey === "string" ? obj.questionKey.trim() : "";
		const insight = typeof obj.insight === "string" ? obj.insight.trim() : "";
		const durabilityRaw =
			typeof obj.durability === "string"
				? obj.durability.trim().toLowerCase()
				: "";
		const confidenceRaw =
			typeof obj.confidence === "number"
				? obj.confidence
				: Number.parseFloat(String(obj.confidence ?? ""));
		const evidence = Array.isArray(obj.evidence)
			? obj.evidence
					.filter((x): x is string => typeof x === "string")
					.map((s) => s.trim())
			: [];
		if (!questionKey || !insight) continue;
		if (insight.length < 20 || insight.length > 800) continue;
		const durability =
			durabilityRaw === "durable"
				? "durable"
				: durabilityRaw === "temporary"
					? "temporary"
					: null;
		if (!durability) continue;
		const confidence = Number.isFinite(confidenceRaw)
			? Math.max(0, Math.min(1, confidenceRaw))
			: 0;
		out.push({
			questionKey,
			insight,
			durability,
			confidence,
			evidence: evidence.filter((x) => x.length > 0).slice(0, 5),
		});
	}
	return out;
}

export async function runIdentityReflection(
	factsDb: FactsDB,
	store: IdentityReflectionStore,
	openai: OpenAI,
	config: IdentityReflectionConfig,
	opts: IdentityReflectionOptions,
	logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<IdentityReflectionResult> {
	if (!config.enabled) {
		return { insightsExtracted: 0, insightsStored: 0, questionsAsked: 0 };
	}

	const windowDays = Math.min(
		90,
		Math.max(1, Math.floor(opts.window ?? config.defaultWindow)),
	);
	const nowSec = Math.floor(Date.now() / 1000);
	const windowStart = nowSec - windowDays * 24 * 3600;
	const scopeFilter = opts.scopeFilter;

	const all = factsDb
		.getAll({ scopeFilter })
		.filter(
			(f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec),
		);
	const patterns = all.filter(
		(f) =>
			f.category === "pattern" &&
			!f.tags?.includes("meta") &&
			f.createdAt >= windowStart,
	);
	const rules = all.filter(
		(f) => f.category === "rule" && f.createdAt >= windowStart,
	);
	const metas = all.filter(
		(f) =>
			f.category === "pattern" &&
			f.tags?.includes("meta") &&
			f.createdAt >= windowStart,
	);
	const insightCount = patterns.length + rules.length + metas.length;
	if (insightCount < config.minInsights) {
		logger.info(
			`memory-hybrid: reflect-identity — insufficient reflection insights (${insightCount}/${config.minInsights})`,
		);
		return {
			insightsExtracted: 0,
			insightsStored: 0,
			questionsAsked: config.questions.length,
		};
	}

	const questionKeys = new Set(config.questions.map((q) => q.key));
	const questionsBlock = config.questions
		.map((q, i) => `${i + 1}. ${q.key}: ${q.prompt}`)
		.join("\n");
	const patternsBlock = patterns
		.slice(0, 30)
		.map((f) => `- ${f.text}`)
		.join("\n");
	const rulesBlock = rules
		.slice(0, 30)
		.map((f) => `- ${f.text}`)
		.join("\n");
	const metasBlock = metas
		.slice(0, 15)
		.map((f) => `- ${f.text}`)
		.join("\n");

	const prompt = fillPrompt(loadPrompt("identity-reflection"), {
		window: String(windowDays),
		questions: questionsBlock,
		patterns: patternsBlock || "- (none)",
		rules: rulesBlock || "- (none)",
		meta: metasBlock || "- (none)",
	});

	let rawResponse: string;
	try {
		rawResponse = await chatCompleteWithRetry({
			model: opts.model,
			content: prompt,
			temperature: 0.2,
			maxTokens: 1800,
			openai,
			fallbackModels: opts.fallbackModels ?? [],
			label: "memory-hybrid: reflect-identity",
			feature: CostFeature.identityReflection,
		});
	} catch (err) {
		logger.warn(`memory-hybrid: reflect-identity LLM failed: ${err}`);
		const retryAttempt = err instanceof LLMRetryError ? err.attemptNumber : 1;
		capturePluginError(err instanceof Error ? err : new Error(String(err)), {
			operation: "identity-reflection-llm",
			subsystem: "openai",
			retryAttempt,
		});
		return {
			insightsExtracted: 0,
			insightsStored: 0,
			questionsAsked: config.questions.length,
		};
	}

	const parsed = parseIdentityReflectionResponse(rawResponse)
		.filter((x) => questionKeys.has(x.questionKey))
		.slice(0, config.maxInsightsPerRun);
	if (parsed.length === 0) {
		return {
			insightsExtracted: 0,
			insightsStored: 0,
			questionsAsked: config.questions.length,
		};
	}

	let stored = 0;
	const runId = randomUUID();
	for (const item of parsed) {
		const latest = store.getLatestByQuestion(item.questionKey);
		if (
			latest &&
			normalizeForDedupe(latest.insight) === normalizeForDedupe(item.insight)
		) {
			continue;
		}
		if (opts.dryRun) {
			stored++;
			continue;
		}
		const question = config.questions.find((q) => q.key === item.questionKey);
		store.create({
			runId,
			questionKey: item.questionKey,
			questionText: question?.prompt ?? item.questionKey,
			insight: item.insight,
			durability: item.durability,
			confidence: item.confidence,
			evidence: item.evidence,
			sourcePatternCount: patterns.length,
			sourceRuleCount: rules.length,
			sourceMetaCount: metas.length,
		});
		stored++;
		if (opts.verbose) {
			logger.info(
				`memory-hybrid: reflect-identity — stored ${item.questionKey} (${item.durability}, conf=${item.confidence.toFixed(2)})`,
			);
		}
	}
	return {
		insightsExtracted: parsed.length,
		insightsStored: stored,
		questionsAsked: config.questions.length,
	};
}
