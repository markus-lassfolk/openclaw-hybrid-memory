/**
 * Type definitions for CLI commands and results.
 */

export type FindDuplicatesResult = {
  pairs: Array<{ idA: string; idB: string; score: number; textA: string; textB: string }>;
  candidatesCount: number;
  skippedStructured: number;
};

export type StoreCliOpts = {
  text: string;
  category?: string;
  entity?: string;
  key?: string;
  value?: string;
  sourceDate?: string;
  tags?: string;
  /** Fact id this store supersedes (replaces). */
  supersedes?: string;
  /** Memory scope (global, user, agent, session). Default global. */
  scope?: "global" | "user" | "agent" | "session";
  /** Scope target (userId, agentId, sessionId). Required when scope is user/agent/session. */
  scopeTarget?: string;
};

export type StoreCliResult =
  | { outcome: "duplicate" }
  | { outcome: "credential"; id: string; service: string; type: string }
  | { outcome: "credential_parse_error" }
  | { outcome: "credential_vault_error" }
  | { outcome: "credential_db_error" }
  | { outcome: "noop"; reason: string }
  | { outcome: "retracted"; targetId: string; reason: string }
  | { outcome: "updated"; id: string; supersededId: string; reason: string }
  | { outcome: "stored"; id: string; textPreview: string; supersededId?: string };

export type InstallCliResult =
  | { ok: true; configPath: string; dryRun: boolean; written: boolean; configJson?: string; pluginId: string }
  | { ok: false; error: string };

export type VerifyCliSink = { log: (s: string) => void; error?: (s: string) => void };

export type DistillWindowResult = { mode: "full" | "incremental"; startDate: string; endDate: string; mtimeDays: number };

export type RecordDistillResult = { path: string; timestamp: string };

export type ExtractDailyResult = { totalExtracted: number; totalStored: number; daysBack: number; dryRun: boolean };
export type ExtractDailySink = { log: (s: string) => void; warn: (s: string) => void };

export type ExtractProceduresResult = {
  sessionsScanned: number;
  proceduresStored: number;
  positiveCount: number;
  negativeCount: number;
  dryRun: boolean;
};

export type GenerateAutoSkillsResult = {
  generated: number;
  skipped: number;
  dryRun: boolean;
  paths: string[];
};

export type BackfillCliResult = { stored: number; skipped: number; candidates: number; files: number; dryRun: boolean };
export type BackfillCliSink = { log: (s: string) => void; warn: (s: string) => void };

export type IngestFilesResult = { stored: number; skipped: number; extracted: number; files: number; dryRun: boolean };
export type IngestFilesSink = { log: (s: string) => void; warn: (s: string) => void };

export type DistillCliResult = { sessionsScanned: number; factsExtracted: number; stored: number; skipped: number; dryRun: boolean };
export type DistillCliSink = { log: (s: string) => void; warn: (s: string) => void };

export type SelfCorrectionExtractResult = {
  incidents: Array<{ userMessage: string; precedingAssistant: string; followingAssistant: string; timestamp?: string; sessionFile: string }>;
  sessionsScanned: number;
};
export type SelfCorrectionRunResult = {
  incidentsFound: number;
  analysed: number;
  autoFixed: number;
  proposals: string[];
  reportPath: string | null;
  toolsSuggestions?: string[];
  toolsApplied?: number;
  error?: string;
};
export type MigrateToVaultResult = { migrated: number; skipped: number; errors: string[] };

export type CredentialsAuditFlaggedEntry = {
  service: string;
  type: string;
  reason: string;
};
export type CredentialsAuditResult = {
  flagged: CredentialsAuditFlaggedEntry[];
  removed: number;
};

export type UpgradeCliResult =
  | { ok: true; version: string; pluginDir: string }
  | { ok: false; error: string };

export type UninstallCliResult =
  | { outcome: "config_updated"; pluginId: string; cleaned: string[] }
  | { outcome: "config_not_found"; pluginId: string; cleaned: string[] }
  | { outcome: "config_error"; error: string; pluginId: string; cleaned: string[] }
  | { outcome: "leave_config"; pluginId: string; cleaned: string[] };

export type ConfigCliResult =
  | { ok: true; configPath: string; message: string }
  | { ok: false; error: string };
