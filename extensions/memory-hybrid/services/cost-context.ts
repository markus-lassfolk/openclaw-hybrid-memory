import { AsyncLocalStorage } from "node:async_hooks";

const costContext = new AsyncLocalStorage<string>();

/**
 * Run `fn` with a named cost-tracking feature label.
 * Any LLM calls made within `fn` will be attributed to `feature` in the cost log.
 * This is opt-in — calls outside a withCostFeature context are labeled "unknown".
 *
 * NOTE: Currently only used in tests. Production code relies on heuristic feature detection.
 * @internal
 */
export function withCostFeature<T>(feature: string, fn: () => T): T {
	return costContext.run(feature, fn);
}

/**
 * Return the current feature label from the nearest enclosing withCostFeature() call,
 * or undefined if no label is active.
 * @internal
 */
export function getCurrentCostFeature(): string | undefined {
	return costContext.getStore();
}
