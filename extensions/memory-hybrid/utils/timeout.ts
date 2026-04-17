/**
 * Shared timeout utility for lifecycle stages.
 * Races a promise against a timeout, returning null if the timeout wins.
 */

export function withTimeout<T>(
	ms: number,
	fn: () => Promise<T>,
): Promise<T | null>;
export function withTimeout<T, F>(
	ms: number,
	fn: () => Promise<T>,
	fallback: F,
): Promise<T | F>;
export function withTimeout<T, F = null>(
	ms: number,
	fn: () => Promise<T>,
	fallback?: F,
): Promise<T | F | null> {
	const fallbackValue = (fallback === undefined ? null : fallback) as F | null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<F | null>((resolve) => {
		timer = setTimeout(() => resolve(fallbackValue), ms);
	});
	return Promise.race([fn(), timeoutPromise]).finally(() => {
		clearTimeout(timer);
	});
}
