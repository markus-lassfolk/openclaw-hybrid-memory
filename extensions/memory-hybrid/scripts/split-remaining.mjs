#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}
function write(rel, content) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  console.log("wrote", rel);
}
function lines(rel) {
  return read(rel).split("\n");
}
function slice(rel, start, end) {
  return lines(rel).slice(start - 1, end).join("\n");
}

// ─── 1. cmd-verify sections ───────────────────────────────────────────────────
const verifyImports = lines("cli/cmd-verify.ts").slice(0, 98).join("\n");

write(
  "cli/verify/verify-run-state.ts",
  `import { getEnv } from "../utils/env-manager.js";
import { isCompactVerbosity, type HybridMemoryConfig } from "../config.js";
import type { HandlerContext } from "../handlers.js";
import type { VerifyCliSink } from "../types.js";
import { readOpenclawConfigRoot, type OpenclawConfigReadResult } from "./openclaw-config.js";
import { detectRecommendedEmbeddingSetup, getDashboardUrl, resolveOpenclawJsonPathForWorkspace } from "../cmd-install.js";
import { findPluginRoot } from "../utils/plugin-root.js";
import { PLUGIN_ID } from "../utils/constants.js";
import { dirname } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
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
        const isOkLine = /^✅|^\\[OK\\]/.test(trimmed);
        const isHeader = /^─{3,}/.test(trimmed);
        const isIndentedStatus = /^\\s{2,}/.test(msg) && !/❌|\\[FAIL\\]|FAIL —|Error|error/.test(msg);
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
      \`OpenClaw config at \${defaultConfigPath} could not be read/parsed (\${openclawConfigRead.error}); compaction watchdog status is unknown and verify used fallback defaults.\`,
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
`,
);

const sectionHeader = (fn) => `${verifyImports}
import type { VerifyRunState } from "../verify-run-state.js";

export async function ${fn}(state: VerifyRunState): Promise<void> {
`;

const mutables = [
  "configOk",
  "sqliteOk",
  "lanceOk",
  "embeddingOk",
  "embeddingAlignmentOk",
  "credentialsOk",
  "allOk",
];

function wrapSection(body, fn) {
  let b = body;
  for (const m of mutables) {
    b = b.replace(new RegExp(`\\b${m}\\s*=`, "g"), `state.${m} =`);
  }
  b = b.replace(/\bissues\.push/g, "state.issues.push");
  b = b.replace(/\bfixes\.push/g, "state.fixes.push");
  b = b.replace(/\bfixes\.pop/g, "state.fixes.pop");
  b = b.replace(/\bwarnings\.push/g, "state.warnings.push");
  b = b.replace(/\bloadBlocking\.push/g, "state.loadBlocking.push");
  b = b.replace(/\bloadBlocking\.some/g, "state.loadBlocking.some");
  return `${sectionHeader(fn)}
  const { ctx, opts, cfg, factsDb, vectorDb, embeddings, credentialsDb, resolvedSqlitePath, resolvedLancePath, openai, log, tableLog, OK, FAIL, PAUSE, WARN_LINE, issues, fixes, warnings, loadBlocking, extDir, defaultConfigPath, openclawDir, openclawConfigRead, recommendedEmbedding, dashboardUrl } = state;

${b}
}
`;
}

const verifySections = [
  ["cli/verify/sections/infrastructure.ts", 182, 343, "runVerifyInfrastructureSection"],
  ["cli/verify/sections/embeddings.ts", 344, 602, "runVerifyEmbeddingsSection"],
  ["cli/verify/sections/llm-models.ts", 603, 1194, "runVerifyLlmModelsSection"],
  ["cli/verify/sections/config-cron.ts", 1196, 1818, "runVerifyConfigCronSection"],
  ["cli/verify/sections/reconcile.ts", 1819, 2194, "runVerifyReconcileSection"],
];

for (const [file, start, end, fn] of verifySections) {
  const body = slice("cli/cmd-verify.ts", start, end);
  write(file, wrapSection(body, fn));
}

write(
  "cli/cmd-verify.ts",
  `${verifyImports}
import { createVerifyRunState, type VerifyRunOpts } from "./verify/verify-run-state.js";
import { runVerifyInfrastructureSection } from "./verify/sections/infrastructure.js";
import { runVerifyEmbeddingsSection } from "./verify/sections/embeddings.js";
import { runVerifyLlmModelsSection } from "./verify/sections/llm-models.js";
import { runVerifyConfigCronSection } from "./verify/sections/config-cron.js";
import { runVerifyReconcileSection } from "./verify/sections/reconcile.js";

export async function runVerifyForCli(
  ctx: import("./handlers.js").HandlerContext,
  opts: VerifyRunOpts,
  sink: import("./types.js").VerifyCliSink,
): Promise<void> {
  const state = createVerifyRunState(ctx, opts, sink);
  await runVerifyInfrastructureSection(state);
  await runVerifyEmbeddingsSection(state);
  await runVerifyLlmModelsSection(state);
  await runVerifyConfigCronSection(state);
  await runVerifyReconcileSection(state);
}
`,
);

// ─── 2. vector-db: extract constants + path-utils, class file ─────────────────
const vdbLines = lines("backends/vector-db.ts");
const classBody = vdbLines.slice(76).join("\n"); // from "export class VectorDB"
const vdbImports = vdbLines.slice(4, 29).join("\n"); // imports without file comment

write(
  "backends/vector-db/constants.ts",
  `export const LANCE_TABLE = "memories";
export const SEMANTIC_QUERY_CACHE_TABLE = "semantic_query_cache";
export const SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY = 100;
export const VECTOR_BULK_DELETE_IN_CHUNK = 200;

export type VectorDBLogger = { warn: (msg: string) => void };

export interface SemanticQueryCacheEntry {
  id: string;
  queryText: string;
  factIds: string[];
  cachedAt: number;
  similarity: number;
  filterKey: string;
}

export const optimizingByPath = new Map<string, boolean>();
export const optimizeFailuresByPath = new Map<string, number>();
export const autoOptimizePauseByPath = new Map<string, number>();
`,
);

write(
  "backends/vector-db/path-utils.ts",
  `import { isAbsolute, relative, resolve as pathResolve } from "node:path";
import { realpathSync } from "node:fs";

export function resolvedPathOrFallback(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return pathResolve(path);
  }
}

export function isPathInsideDir(rootDirAbs: string, candidatePath: string): boolean {
  const rootResolved = resolvedPathOrFallback(rootDirAbs);
  const candidateAbs = isAbsolute(candidatePath) ? candidatePath : pathResolve(candidatePath);
  const candidateResolved = resolvedPathOrFallback(candidateAbs);
  const rel = relative(rootResolved, candidateResolved);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}
`,
);

// Replace module-level const references in class
let classFixed = classBody
  .replace(/\b_optimizingByPath\b/g, "optimizingByPath")
  .replace(/\b_optimizeFailuresByPath\b/g, "optimizeFailuresByPath")
  .replace(/\b_autoOptimizePauseByPath\b/g, "autoOptimizePauseByPath");

write(
  "backends/vector-db/vector-db-class.ts",
  `/**
 * LanceDB VectorDB class implementation.
 */
${vdbImports}
import {
  autoOptimizePauseByPath,
  LANCE_TABLE,
  optimizingByPath,
  optimizeFailuresByPath,
  SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY,
  SEMANTIC_QUERY_CACHE_TABLE,
  VECTOR_BULK_DELETE_IN_CHUNK,
  type SemanticQueryCacheEntry,
  type VectorDBLogger,
} from "./constants.js";
import { isPathInsideDir, resolvedPathOrFallback } from "./path-utils.js";

${classFixed}
`,
);

write(
  "backends/vector-db.ts",
  `/**
 * LanceDB vector backend for semantic search.
 */
export { VectorDB } from "./vector-db/vector-db-class.js";
export type { VectorDBLogger } from "./vector-db/constants.js";
export { isPathInsideDir, resolvedPathOrFallback } from "./vector-db/path-utils.js";
`,
);

// ─── 3. cmd-install splits ────────────────────────────────────────────────────
const installPath = "cli/cmd-install.ts";
const installImports = lines(installPath).slice(0, 48).join("\n");

const installChunks = [
  ["cli/install/workspace.ts", 49, 383, "workspace and skill helpers"],
  ["cli/install/cron-jobs.ts", 384, 1306, "cron job installers"],
  ["cli/install/config-merge.ts", 1307, 1591, "config merge and defaults"],
  ["cli/install/embedding-detect.ts", 1592, 1789, "embedding detection"],
  ["cli/install/run-install.ts", 1790, 2252, "install/uninstall/upgrade runners"],
];

for (const [file, start, end] of installChunks) {
  const body = slice(installPath, start, end);
  write(
    file,
    `${installImports}

${body}
`,
  );
}

write(
  "cli/cmd-install.ts",
  `${installImports}
export * from "./install/workspace.js";
export * from "./install/cron-jobs.js";
export * from "./install/config-merge.js";
export * from "./install/embedding-detect.js";
export * from "./install/run-install.js";
`,
);

// ─── 4. cli-context splits ────────────────────────────────────────────────────
const cliCtx = lines("setup/cli-context.ts");
const cliImports = cliCtx.slice(0, 48).join("\n");
const helpText = cliCtx.slice(48, 175).join("\n");

write(
  "setup/cli-context/help-text.ts",
  `${cliImports}
${slice("setup/cli-context.ts", 49, 170)}
`,
);

write(
  "setup/cli-context/metadata.ts",
  `${cliImports}
${slice("setup/cli-context.ts", 172, 183)}
`,
);

write(
  "setup/cli-context/cli-services.ts",
  `${cliImports}
${slice("setup/cli-context.ts", 185, 561)}
`,
);

write(
  "setup/cli-context/register-full.ts",
  `${cliImports}
import { createHybridMemCliContext, buildCliContextServices } from "./cli-services.js";
${slice("setup/cli-context.ts", 563, 602)}
`,
);

write(
  "setup/cli-context/register-help.ts",
  `${cliImports}
import { createHybridMemCliContext, buildCliContextServices } from "./cli-services.js";
${slice("setup/cli-context.ts", 604, 1156)}
`,
);

write(
  "setup/cli-context/register-cli-with-help.ts",
  `${cliImports}
import { createHybridMemCliContext, buildCliContextServices } from "./cli-services.js";
import type { RegisterHybridMemCliWithApiOptions } from "./register-full.js";
${slice("setup/cli-context.ts", 1157, 1199)}
`,
);

write(
  "setup/cli-context.ts",
  `// @ts-nocheck
export * from "./cli-context/help-text.js";
export { registerHybridMemCliMetadataOnly } from "./cli-context/metadata.js";
export {
  buildCliContextServices,
  createHybridMemCliContext,
  type HybridMemCliRegistrationContext,
} from "./cli-context/cli-services.js";
export { registerHybridMemCliWithApi, type RegisterHybridMemCliWithApiOptions } from "./cli-context/register-full.js";
export { registerHybridMemCliHelpOnlyWithApi } from "./cli-context/register-help.js";
`,
);

// ─── 5. dashboard splits ──────────────────────────────────────────────────────
const dash = lines("routes/dashboard-server.ts");
const dashImports = dash.slice(0, 41).join("\n");

write(
  "routes/dashboard/collectors.ts",
  `${dashImports}
${slice("routes/dashboard-server.ts", 42, 1168)}
`,
);

write(
  "routes/dashboard/html.ts",
  `${dashImports}
${slice("routes/dashboard-server.ts", 1169, 1520)}
`,
);

write(
  "routes/dashboard/server.ts",
  `${dashImports}
import { getDashboardHtml } from "./html.js";
import {
  collectStatus,
  collectForgeState,
  performFactAction,
} from "./collectors.js";

${slice("routes/dashboard-server.ts", 1521, 2134)}
`,
);

write(
  "routes/dashboard-server.ts",
  `export { createDashboardServer, type DashboardServer } from "./dashboard/server.js";
export { collectStatus, collectForgeState } from "./dashboard/collectors.js";
`,
);

// ─── 6. lifecycle stage-recall: extract runRecall ─────────────────────────────
write(
  "lifecycle/stage-recall/run-recall.ts",
  `${lines("lifecycle/stage-recall.ts").slice(0, 32).join("\n")}
${slice("lifecycle/stage-recall.ts", 72, 841)}
`,
);

write(
  "lifecycle/stage-recall.ts",
  `${lines("lifecycle/stage-recall.ts").slice(0, 71).join("\n")}
import { runRecall } from "./stage-recall/run-recall.js";
${lines("lifecycle/stage-recall.ts").slice(71, 72).join("\n")}
`,
);

// ─── 7. lifecycle stage-capture: extract runCapture ───────────────────────────
write(
  "lifecycle/stage-capture/run-capture.ts",
  `${lines("lifecycle/stage-capture.ts").slice(0, 114).join("\n")}
${slice("lifecycle/stage-capture.ts", 124, 1005)}
`,
);

write(
  "lifecycle/stage-capture.ts",
  `${lines("lifecycle/stage-capture.ts").slice(0, 123).join("\n")}
import { runCapture } from "./stage-capture/run-capture.js";

export async function runCaptureStage(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<void> {
  await withTimeout(CAPTURE_STAGE_TIMEOUT_MS, () => runCapture(event, api, ctx, sessionState));
}
`,
);

console.log("all splits complete");
