import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

type CaptureOrigin = "interactive" | "system" | "cron";

interface CaptureProvenance {
	origin: CaptureOrigin;
	messageChannel: string | null;
	sessionId: string | null;
	shouldAutoCapture: boolean;
	reason?: string;
}

type CaptureEvent = {
	prompt?: unknown;
	messages?: unknown[];
};

const CRON_PROMPT_PATTERNS = [
	/GUARD CHECK \(issue #305\)/i,
	/Nightly memory maintenance\./i,
	/Run self-correction analysis:/i,
];

function normalizeMessageChannel(channel: unknown): string | null {
	if (typeof channel !== "string") return null;
	const normalized = channel.trim().toLowerCase();
	return normalized ? normalized : null;
}

function extractEventText(event: unknown): string[] {
	const texts: string[] = [];
	const ev = (event ?? {}) as CaptureEvent;

	if (typeof ev.prompt === "string" && ev.prompt.trim()) {
		texts.push(ev.prompt);
	}

	for (const msg of ev.messages ?? []) {
		if (!msg || typeof msg !== "object") continue;
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string" && content.trim()) {
			texts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			if ((block as { type?: unknown }).type !== "text") continue;
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) {
				texts.push(text);
			}
		}
	}

	return texts;
}

function matchesCronPrompt(texts: string[]): boolean {
	return texts.some((text) =>
		CRON_PROMPT_PATTERNS.some((pattern) => pattern.test(text)),
	);
}

export function resolveCaptureProvenance(
	event: unknown,
	api: Pick<ClawdbotPluginApi, "context">,
	sessionId?: string | null,
): CaptureProvenance {
	const messageChannel = normalizeMessageChannel(api.context?.messageChannel);
	const texts = extractEventText(event);
	const hasCronPrompt = matchesCronPrompt(texts);

	if (messageChannel === "system" && hasCronPrompt) {
		return {
			origin: "cron",
			messageChannel,
			sessionId: sessionId ?? api.context?.sessionId ?? null,
			shouldAutoCapture: false,
			reason: "system cron session",
		};
	}

	if (messageChannel === "system") {
		return {
			origin: "system",
			messageChannel,
			sessionId: sessionId ?? api.context?.sessionId ?? null,
			shouldAutoCapture: false,
			reason: "non-interactive system channel",
		};
	}

	if (hasCronPrompt) {
		return {
			origin: "cron",
			messageChannel,
			sessionId: sessionId ?? api.context?.sessionId ?? null,
			shouldAutoCapture: false,
			reason: "detected cron maintenance prompt",
		};
	}

	return {
		origin: "interactive",
		messageChannel,
		sessionId: sessionId ?? api.context?.sessionId ?? null,
		shouldAutoCapture: true,
	};
}

export function getAutoCaptureExtractionMethod(
	role: "user" | "assistant",
	provenance: Pick<CaptureProvenance, "origin">,
): string {
	return `auto-capture:${role}:${provenance.origin}`;
}

export function getAutoCaptureExtractionConfidence(
	role: "user" | "assistant",
): number {
	return role === "user" ? 1.0 : 0.7;
}
