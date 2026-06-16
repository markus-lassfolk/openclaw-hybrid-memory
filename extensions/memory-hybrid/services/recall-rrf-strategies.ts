export type RecallMode = "semantic" | "hybrid" | "keyword";

/**
 * Select RRF strategies for explicit `memory_recall` based on recall mode.
 * Legacy tag-only recall skips embedding generation; in that case semantic-only
 * mode would leave no viable strategy, so keyword strategies are kept instead.
 */
export function resolveRecallRrfStrategies(
  recallMode: RecallMode,
  configuredStrategies: readonly string[],
  useLegacyTagShortcut: boolean,
): string[] {
  let strategies: string[];
  if (recallMode === "semantic" && !useLegacyTagShortcut) {
    strategies = configuredStrategies.filter((s) => s === "semantic");
  } else if (recallMode === "hybrid") {
    strategies = [...configuredStrategies];
  } else {
    strategies = configuredStrategies.filter((s) => s !== "semantic");
  }
  if (recallMode === "semantic" && !useLegacyTagShortcut && !strategies.includes("semantic")) {
    strategies = ["semantic"];
  }
  return strategies;
}
