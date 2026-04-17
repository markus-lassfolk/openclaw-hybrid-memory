/**
 * OAuth/API failover with exponential backoff.
 * When a provider has both OAuth and API key, we prefer OAuth by default.
 * On OAuth failure we record backoff and use API until the backoff expires;
 * backoff schedule: 5min → 30min → 1h → 2h → 4h. Counter resets every X hours.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DEFAULT_BACKOFF_MINUTES = [5, 30, 60, 120, 240];
const DEFAULT_RESET_AFTER_HOURS = 24;

type AuthFailoverOptions = {
	/** Backoff delays in minutes per level (0-indexed). Default [5, 30, 60, 120, 240]. */
	backoffScheduleMinutes?: number[];
	/** Reset backoff levels after this many hours. Default 24. */
	resetBackoffAfterHours?: number;
	/** Path to JSON file for persistence (survives restart). */
	statePath?: string;
};

type AuthFailoverState = {
	lastResetTs: number;
	providers: Record<string, { backoffUntil: number; level: number }>;
};

function loadState(statePath: string): AuthFailoverState {
	if (!statePath || !existsSync(statePath)) {
		return { lastResetTs: Date.now(), providers: {} };
	}
	try {
		const raw = readFileSync(statePath, "utf-8");
		const data = JSON.parse(raw) as AuthFailoverState;
		if (
			typeof data.lastResetTs !== "number" ||
			typeof data.providers !== "object"
		) {
			return { lastResetTs: Date.now(), providers: {} };
		}
		return data;
	} catch {
		return { lastResetTs: Date.now(), providers: {} };
	}
}

function saveState(statePath: string, state: AuthFailoverState): void {
	if (!statePath) return;
	try {
		writeFileSync(statePath, JSON.stringify(state, null, 0), "utf-8");
	} catch {
		/* non-fatal */
	}
}

/**
 * Returns true when OAuth for this provider is in backoff (we should use API instead).
 * Also runs reset-if-due so the counter is cleared after resetBackoffAfterHours.
 */
export function isOAuthInBackoff(
	provider: string,
	options: AuthFailoverOptions = {},
): boolean {
	const _schedule = options.backoffScheduleMinutes ?? DEFAULT_BACKOFF_MINUTES;
	const resetHours =
		options.resetBackoffAfterHours ?? DEFAULT_RESET_AFTER_HOURS;
	const statePath = options.statePath;
	const state = statePath
		? loadState(statePath)
		: { lastResetTs: Date.now(), providers: {} };

	const now = Date.now();
	if (now - state.lastResetTs >= resetHours * 60 * 60 * 1000) {
		state.lastResetTs = now;
		state.providers = {};
		if (statePath) saveState(statePath, state);
		return false;
	}

	const entry = state.providers[provider];
	if (!entry) return false;
	if (now >= entry.backoffUntil) return false;
	return true;
}

/**
 * Record an OAuth failure for the provider. Advances backoff level (cap at schedule length - 1)
 * and sets backoffUntil = now + schedule[level] minutes. Persists state when statePath is set.
 */
export function recordOAuthFailure(
	provider: string,
	options: AuthFailoverOptions = {},
): void {
	const schedule = options.backoffScheduleMinutes ?? DEFAULT_BACKOFF_MINUTES;
	const statePath = options.statePath;
	const state = statePath
		? loadState(statePath)
		: { lastResetTs: Date.now(), providers: {} };

	const now = Date.now();
	const entry = state.providers[provider];
	const nextLevel = entry ? Math.min(entry.level + 1, schedule.length - 1) : 0;
	const delayMs = schedule[nextLevel] * 60 * 1000;
	state.providers[provider] = { backoffUntil: now + delayMs, level: nextLevel };
	if (statePath) saveState(statePath, state);
}

/**
 * Clear backoff for a provider (e.g. after manual reset or success).
 * If statePath is set, loads and saves; otherwise no-op for persistence.
 */
function clearOAuthBackoff(
	provider: string,
	options: AuthFailoverOptions = {},
): void {
	const statePath = options.statePath;
	if (!statePath) return;
	const state = loadState(statePath);
	if (state.providers[provider]) {
		delete state.providers[provider];
		saveState(statePath, state);
	}
}

/**
 * Clear all backoff state (and optionally reset lastResetTs).
 */
export function resetAllBackoff(
	options: AuthFailoverOptions & { resetTimer?: boolean } = {},
): void {
	const statePath = options.statePath;
	const state = statePath
		? loadState(statePath)
		: { lastResetTs: Date.now(), providers: {} };
	state.providers = {};
	if (options.resetTimer !== false) state.lastResetTs = Date.now();
	if (statePath) saveState(statePath, state);
}

export { DEFAULT_BACKOFF_MINUTES, DEFAULT_RESET_AFTER_HOURS };
