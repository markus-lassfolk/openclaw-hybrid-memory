import { getEnv } from "../../utils/env-manager.js";
import { isCompactVerbosity, type HybridMemoryConfig } from "../../config.js";
import type { HandlerContext } from "../handlers.js";
import type { VerifyCliSink } from "../types.js";
import { readOpenclawConfigRoot, type OpenclawConfigReadResult } from "./openclaw-config.js";
import { detectRecommendedEmbeddingSetup, getDashboardUrl, resolveOpenclawJsonPathForWorkspace } from "../cmd-install.js";
import { findPluginRoot } from "../../utils/plugin-root.js";
import { PLUGIN_ID } from "../../utils/constants.js";
import { dirname } from "node:path";
import type { FactsDB } from "../../backends/facts-db.js";
import type { VectorDB } from "../../backends/vector-db.js";
import type { EmbeddingProvider } from "../../services/embeddings.js";
import type { CredentialsDB } from "../../backends/credentials-db.js";
import type OpenAI from "openai";

export type VerifyRunOpts = {
  fix: boolean;
  logFile?: string;
  testLlm?: boolean;
  reconcile?: boolean;
  reconcilePolicy?: "conservative" | "balanced" | "aggressive";
  reconcileMaxFixes?: number;
};

export type VerifyRunState = {
  ctx: HandlerContext;
  opts: VerifyRunOpts;
  sink: VerifyCliSink;
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  credentialsDb: CredentialsDB | null;
  resolvedSqlitePath: string;
  resolvedLancePath: string;
  openai: OpenAI;
  log: (msg: string) => void;
  tableLog: (msg: string) => void;
  rawLog: (msg: string) => void;
  OK: string;
  FAIL: string;
  PAUSE: string;
  WARN_LINE: string;
  noEmoji: boolean;
  rawPluginConfig?: Record<string, unknown>;
  lanceBindingsFailed: boolean;
  anyEmbOk: boolean;
  issues: string[];
  fixes: string[];
  warnings: string[];
  configOk: boolean;
  sqliteOk: boolean;
  lanceOk: boolean;
  embeddingOk: boolean;
  embeddingAlignmentOk: boolean;
  loadBlocking: string[];
  extDir: string;
  defaultConfigPath: string;
  openclawDir: string;
  openclawConfigRead: OpenclawConfigReadResult;
  recommendedEmbedding: ReturnType<typeof detectRecommendedEmbeddingSetup>;
  dashboardUrl: string;
  credentialsOk: boolean;
  allOk: boolean;
};

export function createVerifyRunState(ctx: HandlerContext, opts: VerifyRunOpts, sink: VerifyCliSink): VerifyRunState {
  const { factsDb, vectorDb, embeddings, cfg, credentialsDb, resolvedSqlitePath, resolvedLancePath, openai } = ctx;
  const verbosity = cfg.verbosity ?? "normal";
  const rawLog = sink.log;
  const log: typeof rawLog = isCompactVerbosity(verbosity)
    ? (msg: string) => {
        const trimmed = msg.trimStart();
        const isOkLine = /^✅|^\[OK\]/.test(trimmed);
        const isHeader = /^─{3,}/.test(trimmed);
        const isIndentedStatus = /^\s{2,}/.test(msg) && !/❌|\[FAIL\]|FAIL —|Error|error/.test(msg);
        if (!isOkLine && !isHeader && !isIndentedStatus) rawLog(msg);
      }
    : rawLog;
  const tableLog = rawLog;
  const noEmoji = getEnv("HYBRID_MEM_NO_EMOJI") === "1";
  const extDir = findPluginRoot(import.meta.url);
  const defaultConfigPath = resolveOpenclawJsonPathForWorkspace();
  const openclawDir = dirname(defaultConfigPath);
  const openclawConfigRead = readOpenclawConfigRoot(defaultConfigPath);
  const recommendedEmbedding = detectRecommendedEmbeddingSetup(
    openclawConfigRead.root ?? { plugins: { entries: { [PLUGIN_ID]: { config: cfg } } } },
    extDir,
  );
  const dashboardUrl = getDashboardUrl(
    openclawConfigRead.root ?? { plugins: { entries: { [PLUGIN_ID]: { config: cfg } } } },
  );
  const warnings: string[] = [];
  if (openclawConfigRead.error) {
    warnings.push(
      `OpenClaw config at ${defaultConfigPath} could not be read/parsed (${openclawConfigRead.error}); compaction watchdog status is unknown and verify used fallback defaults.`,
    );
  }
  return {
    ctx,
    opts,
    sink,
    cfg,
    factsDb,
    vectorDb,
    embeddings,
    credentialsDb,
    resolvedSqlitePath,
    resolvedLancePath,
    openai,
    log,
    tableLog,
    rawLog,
    OK: noEmoji ? "[OK]" : "✅",
    FAIL: noEmoji ? "[FAIL]" : "❌",
    PAUSE: noEmoji ? "[paused]" : "⏸️ ",
    WARN_LINE: noEmoji ? "[WARN]" : "⚠️",
    noEmoji,
    lanceBindingsFailed: false,
    anyEmbOk: false,
    issues: [],
    fixes: [],
    warnings,
    configOk: true,
    sqliteOk: false,
    lanceOk: false,
    embeddingOk: false,
    embeddingAlignmentOk: true,
    loadBlocking: [],
    extDir,
    defaultConfigPath,
    openclawDir,
    openclawConfigRead,
    recommendedEmbedding,
    dashboardUrl,
    credentialsOk: true,
    allOk: true,
  };
}
