/** MiniMax wire model IDs for api.minimax.io */
export const MODELS = {
  m27Highspeed: "MiniMax-M2.7-highspeed",
  m3: "MiniMax-M3",
} as const;

export type AbModelId = (typeof MODELS)[keyof typeof MODELS];

export type AbThinkingMode = "disabled" | "adaptive" | "enabled";

export type AbTaskId = "self-correction" | "reinforcement" | "distill" | "reflection" | "consolidation";

export type AbCellMetrics = {
  task: AbTaskId;
  model: AbModelId;
  thinking: AbThinkingMode;
  ok: boolean;
  error?: string;
  latencyMs: number;
  inputTokensEst?: number;
  outputTokensEst?: number;
  /** Task-specific operational metrics */
  operational: Record<string, number | string | boolean | null>;
  /** Raw or parsed output sample (truncated in metrics.json) */
  outputPreview?: string;
};

export type AbCorpusMeta = {
  sessionFiles: number;
  selfCorrectionIncidents: number;
  reinforcementIncidents: number;
  factsCount: number;
  consolidationClusters: number;
  distillChars: number;
  extractedAt: string;
};

export type AbRunResult = {
  timestamp: string;
  thinkingLevels: AbThinkingMode[];
  corpus: AbCorpusMeta;
  cells: AbCellMetrics[];
};
