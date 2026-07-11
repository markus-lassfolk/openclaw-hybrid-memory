/**
 * Keys accepted under `graph` in openclaw config (read by `parseGraphConfig`).
 * Must stay in sync with `openclaw.plugin.json` → configSchema.properties.graph.properties
 * when graph.additionalProperties is false (gateway validation rejects unknown keys).
 */
export const GRAPH_CONFIG_INPUT_KEYS = [
  "enabled",
  "autoLink",
  "autoLinkMinScore",
  "autoLinkStrength",
  "autoLinkSimilarityThreshold",
  "autoLinkLimit",
  "maxTraversalDepth",
  "useInRecall",
  "coOccurrenceWeight",
  "autoSupersede",
  "strengthenOnRecall",
  "temporalEdges",
  "autoLinkBudgetPerMin",
  "linkDecay",
  "hubDegreeCap",
  "hubScorePenalty",
] as const;

export type GraphConfigInputKey = (typeof GRAPH_CONFIG_INPUT_KEYS)[number];
