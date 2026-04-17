import { getEnv } from "../utils/env-manager.js";
import { compareVersions } from "../utils/version-check.js";

export { compareVersions };

/**
 * Error Reporter Service for GlitchTip Integration
 *
 * SECURITY REQUIREMENTS (NON-NEGOTIABLE):
 * - consent: true by default — user must explicitly opt OUT
 * - No real user data: no memory text, prompts, conversation content, or user identity
 * - MAX_BREADCRUMBS: 10 — only plugin.* category allowed, message/data stripped
 * - sanitizeEvent() rebuilds event from scratch using allowlist before sending
 * - NEVER include: memory text, prompts, API keys, home paths, IPs, emails
 * - Opt-in bot identity only: user.id/user.username are anonymous bot UUID/name (not real user data)
 * - Rate limiting: 60s dedup window for same error fingerprint
 *
 * Uses native fetch (Node 20+) — no @sentry/node dependency.
 */

const MAX_BREADCRUMBS = 10;

/**
 * Default GlitchTip DSN for anonymous crash reporting.
 * This DSN is safe to expose publicly — it only allows ingest (write), not read.
 * Users can opt out by setting errorReporting.consent: false or errorReporting.enabled: false.
 * Privacy: No PII, prompts, API keys, or user data is ever sent. See sanitizeEvent().
 */
export const DEFAULT_GLITCHTIP_DSN =
	"https://7d641cabffdb4557a7bd2f02c338dc80@glitchtip.lassfolk.cc/1";

export interface ErrorReporterConfig {
	enabled: boolean;
	/** DSN for self-hosted mode. Community mode uses COMMUNITY_DSN constant. */
	dsn?: string;
	/** "community" (default): use hardcoded community DSN. "self-hosted": require custom DSN from config. */
	mode: "community" | "self-hosted";
	environment?: string; // "production" | "development"
	maxBreadcrumbs: number; // PRIVACY: Hard-coded to MAX_BREADCRUMBS (limited plugin.* breadcrumbs only). Not user-configurable.
	sampleRate: number; // 0.0-1.0, default 1.0
	consent: boolean; // explicit opt-in required
	/**
	 * Opt-in: Only sent when explicitly configured. Not sent by default for privacy.
	 * Optional UUID for this bot instance; sent as tag so GlitchTip can group errors by bot.
	 */
	botId?: string;
	/**
	 * Opt-in: Only sent when explicitly configured. Not sent by default for privacy.
	 * Optional friendly name for this bot; sent as tag for readable reports.
	 */
	botName?: string;
	/**
	 * Optional map of error fingerprints to the version that fixed them.
	 * Errors matching a fingerprint from an older version are silently dropped (not regressions).
	 * Format: { "ErrorType:message prefix (first 100 chars)": "YYYY.M.NNN" }
	 * When not configured, behavior is identical to today.
	 */
	resolvedIssues?: Record<string, string>;
}

/** Hardcoded DSN for community error reporting (anonymous telemetry) */
const COMMUNITY_DSN = DEFAULT_GLITCHTIP_DSN;

// --- Internal wire-protocol types (GlitchTip / Sentry envelope format) ---

interface ReportFrame {
	filename?: string;
	function?: string;
	lineno?: number;
	colno?: number;
	in_app?: boolean;
}

interface ReportStacktrace {
	frames?: ReportFrame[];
}

interface ReportExceptionValue {
	type?: string;
	value?: string;
	stacktrace?: ReportStacktrace;
}

interface ReportBreadcrumb {
	category?: string;
	level?: string;
	timestamp?: number;
	type?: string;
}

export interface GlitchTipEvent {
	event_id?: string;
	timestamp?: number;
	platform?: string;
	level?: string;
	release?: string;
	environment?: string;
	server_name?: string;
	fingerprint?: string[];
	exception?: { values?: ReportExceptionValue[] };
	tags?: Record<string, string | undefined>;
	contexts?: Record<string, Record<string, unknown>>;
	breadcrumbs?: ReportBreadcrumb[];
	user?: { id?: string; username?: string };
	[key: string]: unknown;
}

interface ErrorLike {
	name?: unknown;
	message?: unknown;
	status?: unknown;
	cause?: unknown;
	causes?: unknown;
	errors?: unknown;
}

const NOISY_NETWORK_ERROR_RE =
	/\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|fetch failed|network timeout|connect\s+ETIMEDOUT|LLM request timeout)\b/i;
const NOISY_AUTH_ERROR_RE =
	/\b(?:401\b|403\b|unauthorized|forbidden|incorrect api key|invalid api key|authentication failed|country,\s*region,\s*or\s*territory\s+not\s+supported|PERMISSION_DENIED)\b/i;
const NOISY_CIRCUIT_BREAKER_RE = /\bcircuit\s+breaker\s+open\b/i;

function getErrorStatus(err: unknown): number | string | undefined {
	if (!err || typeof err !== "object") return undefined;
	return (err as ErrorLike).status as number | string | undefined;
}

function getErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (
		err &&
		typeof err === "object" &&
		typeof (err as ErrorLike).message === "string"
	) {
		return (err as ErrorLike).message as string;
	}
	return "";
}

function getNestedErrors(err: unknown): unknown[] {
	if (!err || typeof err !== "object") return [];
	const nested: unknown[] = [];
	const cause = (err as ErrorLike).cause;
	if (cause != null) nested.push(cause);

	const causes = (err as ErrorLike).causes;
	if (Array.isArray(causes)) nested.push(...causes);

	const errors = (err as ErrorLike).errors;
	if (Array.isArray(errors)) nested.push(...errors);

	return nested;
}

function isFilePermissionMessage(message: string): boolean {
	return /\b(file|directory|path|disk)\b/i.test(message);
}

function isDirectNoisyError(err: unknown): boolean {
	if (
		err &&
		typeof err === "object" &&
		(err as ErrorLike).name === "UnconfiguredProviderError"
	) {
		return true;
	}

	const status = getErrorStatus(err);
	if (
		status === 401 ||
		status === "401" ||
		status === 403 ||
		status === "403"
	) {
		return true;
	}

	const message = getErrorMessage(err).trim();
	if (!message) return false;

	if (NOISY_NETWORK_ERROR_RE.test(message)) return true;
	if (NOISY_CIRCUIT_BREAKER_RE.test(message)) return true;
	if (NOISY_AUTH_ERROR_RE.test(message) && !isFilePermissionMessage(message))
		return true;

	return false;
}

/**
 * Returns true for known noisy, non-actionable errors that should never be sent
 * to GlitchTip: transient transport failures, external-provider auth failures,
 * local Ollama circuit-breaker errors, and aggregates whose nested causes are all noisy.
 */
export function shouldDropNoisyError(
	err: unknown,
	seen = new Set<unknown>(),
): boolean {
	if (!err || (typeof err !== "object" && !(err instanceof Error)))
		return false;
	if (seen.has(err)) return false;
	seen.add(err);

	if (isDirectNoisyError(err)) return true;

	const nested = getNestedErrors(err);
	if (nested.length === 0) return false;

	const uniqueNested = Array.from(new Set(nested));
	return uniqueNested.every((nestedErr) =>
		shouldDropNoisyError(nestedErr, seen),
	);
}

// --- Pure utility functions ---

/**
 * Extract version string from a release identifier.
 * "openclaw-hybrid-memory@2026.3.110" → "2026.3.110"
 * Returns null if the release string can't be parsed.
 */
export function extractVersion(release: string): string | null {
	if (!release) return null;
	const atIdx = release.indexOf("@");
	if (atIdx < 0) return null;
	const version = release.slice(atIdx + 1);
	if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return null;
	return version;
}

/**
 * Compare two version strings numerically (YYYY.M.N format).
 * Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 */
/**
 * Check whether an event should be dropped because it matches a known-fixed issue
 * and the event's release version is older than the fix.
 * Returns true (drop) only when: fingerprint matches AND version < fixedInVersion.
 * If event release can't be parsed, returns false (safe default: let through).
 *
 * NOTE: errValue is read from the event and passed through scrubString() before
 * building the fingerprint. When called from the send pipeline, the event has already been
 * through sanitizeEvent() (which also applies scrubString()), so resolvedIssues
 * keys must use the post-sanitize (scrubbed) form of the error message.
 */
export function shouldDropForResolvedIssue(
	event: GlitchTipEvent,
	resolvedIssues: Record<string, string>,
	fallbackRelease?: string,
): boolean {
	if (!resolvedIssues || Object.keys(resolvedIssues).length === 0) return false;

	const errType = event.exception?.values?.[0]?.type || "Error";
	// Apply scrubString so the fingerprint matches post-sanitize values (same as capturePluginError dedup).
	const errValue = scrubString(event.exception?.values?.[0]?.value || "");
	const fingerprint = `${errType}:${errValue.slice(0, 100)}`;

	const fixedInVersion = resolvedIssues[fingerprint];
	if (!fixedInVersion || typeof fixedInVersion !== "string") return false;

	// Reject malformed fixedInVersion to avoid silently suppressing real errors.
	if (!/^\d+\.\d+\.\d+/.test(fixedInVersion)) return false;

	const releaseStr = event.release || fallbackRelease || "";
	const eventVersion = extractVersion(releaseStr);
	if (!eventVersion) return false;

	return compareVersions(eventVersion, fixedInVersion) < 0;
}

/**
 * Scrub sensitive data from strings
 */
export function scrubString(input: string): string {
	return (
		input
			// API keys (OpenAI, Anthropic, GitHub)
			.replace(
				/sk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_]{20,})/g,
				"[REDACTED]",
			) // OpenAI (sk-, sk-proj-)
			.replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED]") // Anthropic
			.replace(/ghp_[A-Za-z0-9]{36}/g, "[REDACTED]") // GitHub PAT
			.replace(/gho_[A-Za-z0-9]{36}/g, "[REDACTED]") // GitHub OAuth
			.replace(/Bearer\s+[\w.-]+/gi, "[REDACTED]")
			.replace(/Basic\s+[A-Za-z0-9+/=_-]+/gi, "[REDACTED]")
			.replace(
				/(?:\?|&)(?:api[_-]?key|token|access_token|password|secret)=[^&\s]+/gi,
				"[REDACTED]",
			)
			// JWT tokens (eyJ...)
			.replace(
				/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
				"[REDACTED]",
			)
			// AWS and other cloud credentials
			.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]") // AWS access keys
			// Slack tokens
			.replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]") // Slack tokens
			// Private keys
			.replace(/-----BEGIN [^-]*PRIVATE KEY-----/g, "[REDACTED]") // PEM private key blocks
			// Connection strings with embedded passwords (generic + specific)
			.replace(/:\/\/[^\s:@]+:[^\s@]+@[^\s/]+/g, "://[REDACTED]@")
			.replace(/postgres:\/\/[^\s]+/g, "postgres://[REDACTED]")
			.replace(/mysql:\/\/[^\s]+/g, "mysql://[REDACTED]")
			.replace(/redis:\/\/[^\s]+/g, "redis://[REDACTED]")
			.replace(/mongodb:\/\/[^\s]+/g, "mongodb://[REDACTED]")
			// Paths
			.replace(/\/home\/[^/\s]+/g, "$HOME")
			.replace(/\/Users\/[^/\s]+/g, "$HOME")
			.replace(/C:\\Users\\[^\\\s]+/g, "%USERPROFILE%")
			// PII
			.replace(/\b[\w.-]+@[\w.-]+\.\w{2,}\b/g, "[EMAIL]")
			.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[IP]")
			// Truncate
			.slice(0, 500)
	);
}

/**
 * Sanitize file paths: keep only relative plugin paths
 */
export function sanitizePath(path: string): string {
	// Try multiple possible plugin directory markers
	const markers = [
		"extensions/openclaw-hybrid-memory/",
		"extensions/memory-hybrid/",
		"openclaw-hybrid-memory/",
	];

	for (const marker of markers) {
		const idx = path.indexOf(marker);
		if (idx >= 0) {
			return path.slice(idx);
		}
	}

	// Fallback: if path contains node_modules or extensions, return basename
	if (path.includes("node_modules") || path.includes("extensions")) {
		const parts = path.split(/[/\\]/);
		return parts[parts.length - 1] || path;
	}

	// Scrub user-specific paths
	return path
		.replace(/\/home\/[^/]+/g, "$HOME")
		.replace(/\/Users\/[^/]+/g, "$HOME")
		.replace(/C:\\Users\\[^\\]+/g, "%USERPROFILE%");
}

/**
 * Sanitize event using ALLOWLIST approach: rebuild event with only safe fields
 */
export function sanitizeEvent(event: GlitchTipEvent): GlitchTipEvent | null {
	if (!event) return null;

	const safe: GlitchTipEvent = {
		event_id: event.event_id,
		timestamp: event.timestamp,
		platform: "node",
		level: event.level,
		release: event.release,
		environment: event.environment,
		server_name: event.server_name
			? scrubString(String(event.server_name).slice(0, 128))
			: undefined,
		fingerprint: event.fingerprint,
		// Only keep exception type and sanitized message
		exception: event.exception
			? {
					values: event.exception.values?.map((v) => ({
						type: v.type,
						value: scrubString(v.value || ""),
						stacktrace: v.stacktrace
							? {
									frames: v.stacktrace.frames?.map((f) => ({
										filename: sanitizePath(f.filename || ""),
										function: f.function,
										lineno: f.lineno,
										colno: f.colno,
										in_app: f.in_app,
										// NO: abs_path, context_line, pre_context, post_context, vars
									})),
								}
							: undefined,
					})),
				}
			: undefined,
		tags: {
			subsystem: event.tags?.subsystem
				? scrubString(String(event.tags.subsystem))
				: undefined,
			operation: event.tags?.operation
				? scrubString(String(event.tags.operation))
				: undefined,
			phase: event.tags?.phase
				? scrubString(String(event.tags.phase))
				: undefined,
			backend: event.tags?.backend
				? scrubString(String(event.tags.backend))
				: undefined,
			node: event.tags?.node
				? scrubString(String(event.tags.node).slice(0, 128))
				: undefined,
			agent_id: event.tags?.agent_id
				? scrubString(String(event.tags.agent_id))
				: undefined,
			agent_name: event.tags?.agent_name
				? scrubString(String(event.tags.agent_name).slice(0, 64))
				: undefined,
			bot_id: event.tags?.bot_id
				? scrubString(String(event.tags.bot_id))
				: undefined,
			bot_name: event.tags?.bot_name
				? scrubString(String(event.tags.bot_name).slice(0, 64))
				: undefined,
			retryAttempt: event.tags?.retryAttempt
				? scrubString(String(event.tags.retryAttempt))
				: undefined,
			memoryCount: event.tags?.memoryCount
				? scrubString(String(event.tags.memoryCount))
				: undefined,
		},
		contexts: {
			...(event.contexts?.config_shape
				? {
						config_shape: Object.fromEntries(
							Object.entries(event.contexts.config_shape).map(([k, v]) => [
								k,
								typeof v === "string" ? scrubString(v) : v,
							]),
						),
					}
				: {}),
			...(event.contexts?.runtime
				? {
						runtime: {
							name: event.contexts.runtime.name,
							version: event.contexts.runtime.version,
						},
					}
				: {}),
			...(event.contexts?.os
				? {
						os: { name: event.contexts.os.name }, // Only name, no version
					}
				: {}),
		},
		breadcrumbs: event.breadcrumbs
			?.filter((b) => b.category?.startsWith("plugin."))
			.map((b) => ({
				category: b.category,
				level: b.level,
				timestamp: b.timestamp,
				type: b.type,
				// Strip message and data to prevent leaking user content
			})),
		// Preserve user.id and user.username for GlitchTip "Users Affected" and grouping
		user: event.user
			? {
					id: event.user.id ? scrubString(String(event.user.id)) : undefined,
					username: event.user.username
						? scrubString(String(event.user.username))
						: undefined,
				}
			: undefined,
		// NO: request, contexts.device, extra
	};

	return safe;
}

// --- GlitchTipReporter: lightweight native-fetch reporter ---

function generateEventId(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

interface ScopeInterface {
	setTag(key: string, value: string): void;
	setContext(key: string, value: Record<string, unknown>): void;
}

class GlitchTipReporter {
	private readonly storeUrl: string;
	private readonly publicKey: string;
	private readonly release: string;
	private readonly environment: string;
	private readonly sampleRate: number;
	private readonly resolvedIssues: Record<string, string>;
	private serverName?: string;

	private globalTags: Record<string, string> = {};
	private breadcrumbs: ReportBreadcrumb[] = [];
	private pendingFetches: Promise<void>[] = [];

	// Current scope — set synchronously during withScope callback
	private currentScopeTags: Record<string, string> = {};
	private currentScopeContexts: Record<string, Record<string, unknown>> = {};

	constructor(
		dsn: string,
		release: string,
		environment: string,
		sampleRate: number,
		resolvedIssues?: Record<string, string>,
	) {
		const url = new URL(dsn);
		this.publicKey = url.username;
		const pathSegments = url.pathname
			.replace(/^\/+|\/+$/g, "")
			.split("/")
			.filter(Boolean);
		const projectId = pathSegments.pop() || "";
		const basePath =
			pathSegments.length > 0 ? `/${pathSegments.join("/")}` : "";
		this.storeUrl = `${url.protocol}//${url.host}${basePath}/api/${projectId}/store/`;
		this.release = release;
		this.environment = environment;
		this.sampleRate = sampleRate;
		this.resolvedIssues = resolvedIssues ?? {};
	}

	setTag(key: string, value: string): void {
		this.globalTags[key] = value;
	}

	setServerName(value: string): void {
		this.serverName = value;
	}

	addBreadcrumb(breadcrumb: {
		category?: string;
		level?: string;
		type?: string;
	}): void {
		// Only allow plugin.* breadcrumbs — strip message/data to prevent leaking user content
		if (!breadcrumb.category?.startsWith("plugin.")) return;
		if (this.breadcrumbs.length >= MAX_BREADCRUMBS) {
			this.breadcrumbs.shift();
		}
		this.breadcrumbs.push({
			category: breadcrumb.category,
			level: breadcrumb.level,
			timestamp: Date.now() / 1000,
			type: breadcrumb.type,
		});
	}

	withScope(callback: (scope: ScopeInterface) => void): void {
		this.currentScopeTags = {};
		this.currentScopeContexts = {};
		callback({
			setTag: (k, v) => {
				this.currentScopeTags[k] = v;
			},
			setContext: (k, v) => {
				this.currentScopeContexts[k] = v;
			},
		});
		// Clear after callback — captureException captured the snapshot during the callback
		this.currentScopeTags = {};
		this.currentScopeContexts = {};
	}

	captureException(error: Error): string {
		// Snapshot scope synchronously (called inside withScope callback)
		const scopeTags = { ...this.currentScopeTags };
		const scopeContexts = { ...this.currentScopeContexts };
		const eventId = generateEventId();

		if (shouldDropNoisyError(error)) {
			return eventId;
		}

		// Sample rate check
		if (this.sampleRate < 1.0 && Math.random() > this.sampleRate) {
			return eventId;
		}

		const rawEvent: GlitchTipEvent = {
			event_id: eventId,
			timestamp: Date.now() / 1000,
			platform: "node",
			level: "error",
			release: this.release,
			environment: this.environment,
			server_name: this.serverName,
			exception: {
				values: [
					{
						type: error.name || "Error",
						value: error.message,
						stacktrace: this.extractStacktrace(error),
					},
				],
			},
			tags: { ...this.globalTags, ...scopeTags },
			contexts: {
				...scopeContexts,
				runtime: { name: "node", version: process.version },
			},
			breadcrumbs: [...this.breadcrumbs],
		};

		// Sanitize: rebuild event from scratch using allowlist — drops any fields not explicitly permitted
		const sanitized = sanitizeEvent(rawEvent);
		if (!sanitized) return eventId;

		// Version-aware filter: drop events already fixed in a newer release
		if (
			shouldDropForResolvedIssue(sanitized, this.resolvedIssues, this.release)
		) {
			return eventId;
		}

		const p = this.send(sanitized).catch(() => {
			// Fire-and-forget: never throw from error reporter
		});
		this.pendingFetches.push(p);

		// Prevent unbounded growth: prune every 20 entries
		if (this.pendingFetches.length > 20) {
			this.pendingFetches = this.pendingFetches.slice(-20);
		}

		return eventId;
	}

	async flush(timeoutMs: number): Promise<boolean> {
		const pending = [...this.pendingFetches];
		this.pendingFetches = [];
		if (pending.length === 0) return true;
		try {
			let timeoutId: NodeJS.Timeout | undefined;
			await Promise.race([
				Promise.all(pending).then((result) => {
					if (timeoutId !== undefined) clearTimeout(timeoutId);
					return result;
				}),
				new Promise<never>((_, reject) => {
					timeoutId = setTimeout(
						() => reject(new Error("Flush timeout")),
						timeoutMs,
					);
				}),
			]);
			return true;
		} catch {
			return false;
		}
	}

	private extractStacktrace(error: Error): ReportStacktrace | undefined {
		if (!error.stack) return undefined;
		const lines = error.stack.split("\n").slice(1); // skip "Error: message" first line
		const frames: ReportFrame[] = lines
			.map((line): ReportFrame | null => {
				if (line.length > 500) return null; // ReDoS guard: skip abnormally long lines
				const trimmed = line.trimStart();
				if (!trimmed.startsWith("at ")) return null; // fast path avoids regex on non-frame lines
				const match = trimmed.match(
					/^at (?:([^()\n]+) \()?([^)\n]+):(\d+):(\d+)\)?/,
				);
				if (!match) return null;
				return {
					function: match[1] || "<anonymous>",
					filename: sanitizePath(match[2]),
					lineno: Number.parseInt(match[3], 10),
					colno: Number.parseInt(match[4], 10),
					in_app: !match[2].includes("node_modules"),
				};
			})
			.filter((f): f is ReportFrame => f !== null)
			.reverse();
		return frames.length > 0 ? { frames } : undefined;
	}

	private async send(event: GlitchTipEvent): Promise<void> {
		const timestamp = Math.floor(Date.now() / 1000);
		const authHeader = `Sentry sentry_version=7, sentry_timestamp=${timestamp}, sentry_client=openclaw-hybrid-memory/native, sentry_key=${this.publicKey}`;
		const resp = await fetch(this.storeUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Sentry-Auth": authHeader,
			},
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(5000),
		});
		const body = await resp.text();
		if (!resp.ok) {
			throw new Error(`GlitchTip rejected event: HTTP ${resp.status} ${body}`);
		}
	}
}

// --- Module-level singleton state ---

let reporter: GlitchTipReporter | null = null;
let initialized = false;
let logger: any = console; // Default fallback to console
const errorDedup = new Map<string, number>(); // Rate limiting: fingerprint -> timestamp
let telemetryMuteReason: string | null = null;

export function setErrorReporterMuted(muted: boolean, reason?: string): void {
	telemetryMuteReason = muted ? (reason ?? "muted") : null;
}

export function getErrorReporterMuteReason(): string | null {
	return telemetryMuteReason;
}

function resolveNodeName(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const candidate =
		typeof env.OPENCLAW_NODE_NAME === "string" && env.OPENCLAW_NODE_NAME.trim()
			? env.OPENCLAW_NODE_NAME.trim()
			: undefined;

	if (!candidate) return undefined;

	return (
		scrubString(candidate)
			.slice(0, 128)
			.replace(/[\x00-\x1f\x7f]/g, "") || undefined
	);
}

/**
 * Initialize error reporter with STRICT privacy settings.
 * Optionally pass runtimeBotId from OpenClaw plugin context (e.g. api.context?.agentId) to use as bot UUID when config.botId is not set.
 */
export async function initErrorReporter(
	config: ErrorReporterConfig,
	pluginVersion: string,
	loggerInstance?: any,
	runtimeBotId?: string,
): Promise<void> {
	if (loggerInstance) {
		logger = loggerInstance;
	}

	if (!config.enabled || !config.consent) {
		logger.info?.(
			"[ErrorReporter] Disabled: enabled=%s, consent=%s",
			config.enabled,
			config.consent,
		);
		return;
	}

	const rawEnvDsn = getEnv("ERROR_REPORTING_DSN");
	const envDsn =
		typeof rawEnvDsn === "string" && rawEnvDsn.trim().length > 0
			? rawEnvDsn.trim()
			: "";

	// Resolve DSN based on mode
	let resolvedDsn: string;
	if (envDsn) {
		resolvedDsn = envDsn;
		logger.info?.("[ErrorReporter] Using DSN from ERROR_REPORTING_DSN");
	} else if (config.mode === "community") {
		// Community mode: allow override via config.dsn, otherwise use COMMUNITY_DSN
		resolvedDsn = config.dsn || COMMUNITY_DSN;
		logger.info?.("[ErrorReporter] Using community mode (anonymous telemetry)");
	} else {
		// self-hosted mode
		if (!config.dsn) {
			logger.warn?.(
				"[ErrorReporter] Self-hosted mode requires a DSN but none was provided. Error reporting disabled.",
			);
			return;
		}
		resolvedDsn = config.dsn;
		logger.info?.("[ErrorReporter] Using self-hosted mode");
	}

	const releaseStr = `openclaw-hybrid-memory@${pluginVersion}`;

	try {
		reporter = new GlitchTipReporter(
			resolvedDsn,
			releaseStr,
			config.environment || "production",
			config.sampleRate ?? 1.0,
			config.resolvedIssues,
		);
	} catch (err) {
		logger.warn?.(
			"[ErrorReporter] Invalid DSN format, error reporting disabled:",
			err instanceof Error ? err.message : String(err),
		);
		return;
	}

	// Bot identity: config first, then OpenClaw context (e.g. api.context?.agentId).
	// When neither is configured, bot_id is omitted entirely — no hostname fallback to prevent leaks.
	const botUuid =
		config.botId ||
		(typeof runtimeBotId === "string" && runtimeBotId.trim()
			? runtimeBotId.trim()
			: undefined);
	let nodeName: string | undefined;
	try {
		nodeName = resolveNodeName();
	} catch {
		nodeName = undefined;
	}
	const botName = config.botName
		? scrubString(config.botName)
				.slice(0, 64)
				.replace(/[\x00-\x1f\x7f]/g, "")
		: undefined;
	if (nodeName) {
		reporter.setServerName(nodeName);
		reporter.setTag("node", nodeName);
	}
	if (botUuid) {
		reporter.setTag("agent_id", botUuid);
		reporter.setTag("bot_id", botUuid);
	}
	if (botName) {
		reporter.setTag("agent_name", botName);
		reporter.setTag("bot_name", botName);
		logger.debug?.("[ErrorReporter] Bot name set (opt-in)");
	} else {
		logger.debug?.(
			"[ErrorReporter] Bot name omitted (not configured — privacy default)",
		);
	}

	initialized = true;
	const dsnHost = resolvedDsn.split("@")[1] || "***";
	logger.info?.("[ErrorReporter] Initialized with DSN host:", dsnHost);
}

/**
 * Capture a plugin error with context
 */
export function capturePluginError(
	error: Error,
	context: {
		operation: string;
		/** Subsystem (e.g. "cli", "reflection", "credentials"). Default "plugin". */
		subsystem?: string;
		configShape?: Record<string, string>;
		phase?: string;
		backend?: string;
		retryAttempt?: number;
		memoryCount?: number;
		/** Severity level (e.g. "info", "warning", "error"). Not sent to reporter, used for local logging/filtering. */
		severity?: string;
		/** Additional context fields for specific operations */
		[key: string]: unknown;
	},
): string | undefined {
	if (shouldDropNoisyError(error)) return undefined;
	if (telemetryMuteReason) return undefined;

	if (!initialized || !reporter) {
		return undefined;
	}

	// Rate limiting: dedup same errors within 60s
	const fingerprint = `${error.name}:${scrubString(error.message).slice(0, 100)}`;
	const now = Date.now();
	const lastSeen = errorDedup.get(fingerprint);
	if (lastSeen && now - lastSeen < 60000) {
		return undefined; // Skip duplicate
	}
	errorDedup.set(fingerprint, now);

	// Prevent memory leak: prune stale entries every 10 new entries
	if (errorDedup.size % 10 === 0) {
		for (const [key, ts] of errorDedup) {
			if (now - ts > 60000) errorDedup.delete(key);
		}
	}

	const subsystem = context.subsystem ?? "plugin";
	let eventId: string | undefined;
	reporter.withScope((scope) => {
		scope.setTag("subsystem", subsystem);
		scope.setTag("operation", context.operation);
		if (context.phase) scope.setTag("phase", context.phase);
		if (context.backend) scope.setTag("backend", context.backend);
		if (context.retryAttempt !== undefined)
			scope.setTag("retryAttempt", String(context.retryAttempt));
		if (context.memoryCount !== undefined)
			scope.setTag("memoryCount", String(context.memoryCount));
		if (context.configShape) {
			scope.setContext("config_shape", context.configShape);
		}
		eventId = reporter?.captureException(error);
	});

	return eventId;
}

/**
 * Check if error reporter is active
 */
export function isErrorReporterActive(): boolean {
	return initialized;
}

/**
 * Flush pending error reports with timeout
 */
export async function flushErrorReporter(timeoutMs = 2000): Promise<boolean> {
	if (!initialized || !reporter) {
		return false;
	}
	try {
		return await reporter.flush(timeoutMs);
	} catch (err) {
		logger.warn?.("[ErrorReporter] Flush failed:", err);
		return false;
	}
}

/**
 * Test error reporter diagnostics
 */
export function testErrorReporter(): { ok: boolean; error?: string } {
	if (!initialized || !reporter) {
		return {
			ok: false,
			error: "Error reporter not initialized (consent or disabled)",
		};
	}
	return { ok: true };
}

/**
 * Capture a test error to verify reporting works
 */
export function captureTestError(): string | null {
	if (telemetryMuteReason) {
		return null;
	}
	if (!initialized || !reporter) {
		return null;
	}
	try {
		const testError = new Error("Test error from captureTestError()");
		return reporter.captureException(testError);
	} catch (err) {
		logger.warn?.("[ErrorReporter] captureTestError failed:", err);
		return null;
	}
}

/**
 * Add operation breadcrumb for plugin subsystems
 */
export function addOperationBreadcrumb(
	subsystem: string,
	operation: string,
): void {
	if (!reporter || !initialized) return;
	reporter.addBreadcrumb({
		category: `plugin.${subsystem}.${operation}`,
		level: "info",
	});
}
