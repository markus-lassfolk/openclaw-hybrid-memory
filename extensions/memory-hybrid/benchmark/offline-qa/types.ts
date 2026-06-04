export type QaPhaseResult = {
  name: string;
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
};

export type QaReport = {
  timestamp: string;
  live: boolean;
  phases: QaPhaseResult[];
  warnings: string[];
};
