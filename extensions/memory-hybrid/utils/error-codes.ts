/**
 * Centralized error codes and user-friendly error messages
 * for the Hybrid Memory plugin.
 */

export type ErrorCode =
	| "HM_E001" // No embedding provider configured
	| "HM_E002" // API key missing
	| "HM_E003" // Provider unavailable
	| "HM_E004" // Database connection failed
	| "HM_E005" // Invalid configuration
	| "HM_E006" // Model not found
	| "HM_E007" // Insufficient permissions
	| "HM_E008" // Operation timeout
	| "HM_E009" // Invalid command syntax
	| "HM_E010"; // Resource not found

interface ErrorInfo {
	code: ErrorCode;
	title: string;
	message: string;
	solution: string;
	docsLink?: string;
}

const ERROR_CATALOG: Record<ErrorCode, Omit<ErrorInfo, "code">> = {
	HM_E001: {
		title: "No Embedding Provider Configured",
		message:
			"The hybrid memory system requires an embedding provider to perform semantic search.",
		solution:
			"Run: openclaw hybrid-mem setup --interactive\nOr manually set: openclaw hybrid-mem config-set embedding.provider ollama",
		docsLink: "https://github.com/markus-lassfolk/openclaw-hybrid-memory#embedding-providers",
	},
	HM_E002: {
		title: "API Key Missing",
		message:
			"The selected embedding provider requires an API key, but none was found.",
		solution:
			"Set your API key:\nopenclaw hybrid-mem config-set embedding.apiKey YOUR_KEY\nOr use a local provider: openclaw hybrid-mem use ollama",
		docsLink: "https://github.com/markus-lassfolk/openclaw-hybrid-memory#configuration",
	},
	HM_E003: {
		title: "Provider Unavailable",
		message: "The embedding provider could not be reached or is not running.",
		solution:
			"For Ollama: Start Ollama service with 'ollama serve'\nFor OpenAI: Check your internet connection and API key\nFor ONNX: Ensure onnxruntime-node is installed",
		docsLink: "https://github.com/markus-lassfolk/openclaw-hybrid-memory#troubleshooting",
	},
	HM_E004: {
		title: "Database Connection Failed",
		message: "Could not connect to the SQLite or LanceDB database.",
		solution:
			"Check database permissions and disk space.\nRun: openclaw hybrid-mem verify --fix\nIf issue persists, try: openclaw hybrid-mem doctor",
		docsLink: "https://github.com/markus-lassfolk/openclaw-hybrid-memory#database-issues",
	},
	HM_E005: {
		title: "Invalid Configuration",
		message: "The configuration contains invalid or conflicting settings.",
		solution:
			"Run: openclaw hybrid-mem config\nTo reset to defaults: openclaw hybrid-mem install\nFor guided setup: openclaw hybrid-mem setup --interactive",
	},
	HM_E006: {
		title: "Model Not Found",
		message: "The specified embedding or LLM model could not be found.",
		solution:
			"Check available models for your provider.\nFor Ollama: Run 'ollama list'\nFor OpenAI: See https://platform.openai.com/docs/models\nOr try: openclaw hybrid-mem providers",
	},
	HM_E007: {
		title: "Insufficient Permissions",
		message: "The operation requires permissions that are not available.",
		solution:
			"Check file/directory permissions on your memory databases.\nEnsure the plugin has write access to ~/.openclaw/plugins/memory-hybrid/",
	},
	HM_E008: {
		title: "Operation Timeout",
		message: "The operation took too long and was cancelled.",
		solution:
			"This may indicate a slow network or overloaded provider.\nTry reducing batch size in config, or retry the operation.",
	},
	HM_E009: {
		title: "Invalid Command Syntax",
		message: "The command syntax is incorrect.",
		solution: "Run: openclaw hybrid-mem --help\nOr try: openclaw hybrid-mem examples",
	},
	HM_E010: {
		title: "Resource Not Found",
		message: "The requested resource (fact, category, etc.) was not found.",
		solution: "Check the ID or name and try again.\nRun: openclaw hybrid-mem list",
	},
};

export class UserFriendlyError extends Error {
	code: ErrorCode;
	solution: string;
	docsLink?: string;

	constructor(code: ErrorCode, customMessage?: string) {
		const info = ERROR_CATALOG[code];
		const message = customMessage || info.message;
		super(message);
		this.name = "UserFriendlyError";
		this.code = code;
		this.solution = info.solution;
		this.docsLink = info.docsLink;
	}

	format(): string {
		const lines = [
			`\n❌ ${ERROR_CATALOG[this.code].title} [${this.code}]`,
			"",
			`   ${this.message}`,
			"",
			"💡 Solution:",
			...this.solution.split("\n").map((line) => `   ${line}`),
		];

		if (this.docsLink) {
			lines.push("", `📚 More info: ${this.docsLink}`);
		}

		return lines.join("\n");
	}
}

/**
 * Convert common errors into user-friendly errors with actionable guidance
 */
export function wrapCommonError(error: unknown): Error {
	if (error instanceof UserFriendlyError) {
		return error;
	}

	const errorMessage = error instanceof Error ? error.message : String(error);
	const lowerMsg = errorMessage.toLowerCase();

	// Detect common error patterns and provide friendly messages
	if (
		lowerMsg.includes("api key") ||
		lowerMsg.includes("unauthorized") ||
		lowerMsg.includes("401")
	) {
		return new UserFriendlyError("HM_E002", errorMessage);
	}

	if (
		lowerMsg.includes("econnrefused") ||
		lowerMsg.includes("network") ||
		lowerMsg.includes("timeout") ||
		lowerMsg.includes("enotfound")
	) {
		return new UserFriendlyError("HM_E003", errorMessage);
	}

	if (
		lowerMsg.includes("database") ||
		lowerMsg.includes("sqlite") ||
		lowerMsg.includes("lancedb")
	) {
		return new UserFriendlyError("HM_E004", errorMessage);
	}

	if (lowerMsg.includes("model") && lowerMsg.includes("not found")) {
		return new UserFriendlyError("HM_E006", errorMessage);
	}

	if (
		lowerMsg.includes("permission") ||
		lowerMsg.includes("eacces") ||
		lowerMsg.includes("eperm")
	) {
		return new UserFriendlyError("HM_E007", errorMessage);
	}

	// Return original error if no pattern matches
	return error instanceof Error ? error : new Error(errorMessage);
}

/**
 * Format error for CLI output with user-friendly guidance
 */
export function formatCliError(error: unknown): string {
	const wrapped = wrapCommonError(error);

	if (wrapped instanceof UserFriendlyError) {
		return wrapped.format();
	}

	// Fallback for unwrapped errors
	const errorMsg = wrapped instanceof Error ? wrapped.message : String(wrapped);
	return `\n❌ Error: ${errorMsg}\n\n💡 For help, run: openclaw hybrid-mem doctor\n`;
}
