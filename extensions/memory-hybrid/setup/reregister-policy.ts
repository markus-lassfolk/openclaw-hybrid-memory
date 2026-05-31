/** @module reregister-policy — Hot-reload DB teardown vs reuse (OPENCLAW_HYBRID_MEM_REREGISTER_POLICY). */
import type { PluginRuntime } from "../api/plugin-runtime.js";
import type { HybridMemoryConfig } from "../config.js";
import { getEnv } from "../utils/env-manager.js";

export type ReregisterPolicy = "default" | "full" | "reuse-databases";

export type ReregisterMetrics = {
  policy: string;
  registrations: number;
  fullTeardowns: number;
  databaseReuses: number;
};

export const reregisterMetrics: ReregisterMetrics = {
  policy: "(unset)",
  registrations: 0,
  fullTeardowns: 0,
  databaseReuses: 0,
};

/** Resolved once per process from OPENCLAW_HYBRID_MEM_REREGISTER_POLICY. */
let cachedPolicy: ReregisterPolicy | null = null;

export function resolveReregisterPolicy(): ReregisterPolicy {
  if (cachedPolicy) return cachedPolicy;
  const raw = getEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY")?.trim().toLowerCase();
  if (raw === "reuse-databases") cachedPolicy = "reuse-databases";
  else if (raw === "full") cachedPolicy = "full";
  else cachedPolicy = "default";
  reregisterMetrics.policy = cachedPolicy;
  return cachedPolicy;
}

/** Default and explicit `full` always close and reopen database handles on re-register. */
export function shouldFullTeardownOnReregister(): boolean {
  return resolveReregisterPolicy() !== "reuse-databases";
}

export function resetReregisterPolicyForTests(): void {
  cachedPolicy = null;
  reregisterMetrics.policy = "(unset)";
  reregisterMetrics.registrations = 0;
  reregisterMetrics.fullTeardowns = 0;
  reregisterMetrics.databaseReuses = 0;
}

export function recordReregisterRegistration(): void {
  resolveReregisterPolicy();
  reregisterMetrics.registrations += 1;
}

export function recordReregisterFullTeardown(): void {
  reregisterMetrics.fullTeardowns += 1;
}

export function recordReregisterDatabaseReuse(): void {
  reregisterMetrics.databaseReuses += 1;
}

type PathResolvingApi = { resolvePath: (p: string) => string };

/** True when re-register may keep existing SQLite/Lance handles (paths unchanged). */
export function canReuseDatabasesOnReregister(
  old: PluginRuntime | null,
  cfg: HybridMemoryConfig,
  api: PathResolvingApi,
): boolean {
  if (!old) return false;
  if (resolveReregisterPolicy() !== "reuse-databases") return false;
  // Reuse only after donor bootstrap has fully settled. If bootstrap is still in flight when
  // generation bumps, supersession can skip one-shot init work (vault/migration checks).
  if (!old.bootstrapSettledRef || old.bootstrapSettledRef.value !== true) return false;
  const nextSqlite = api.resolvePath(cfg.sqlitePath);
  const nextLance = api.resolvePath(cfg.lanceDbPath);
  if (old.resolvedSqlitePath !== nextSqlite || old.resolvedLancePath !== nextLance) return false;

  // Compare embedding config to detect provider/model/endpoint changes that require rebuilding clients
  const oldCfg = old.cfg;
  if (
    oldCfg.embedding.provider !== cfg.embedding.provider ||
    oldCfg.embedding.model !== cfg.embedding.model ||
    oldCfg.embedding.endpoint !== cfg.embedding.endpoint ||
    oldCfg.embedding.apiKey !== cfg.embedding.apiKey ||
    oldCfg.embedding.deployment !== cfg.embedding.deployment
  ) {
    return false;
  }

  // Compare LLM config to detect model/provider changes that require rebuilding openai client
  const oldLlm = oldCfg.llm;
  const newLlm = cfg.llm;
  if (JSON.stringify(oldLlm?.default) !== JSON.stringify(newLlm?.default)) return false;
  if (JSON.stringify(oldLlm?.heavy) !== JSON.stringify(newLlm?.heavy)) return false;
  if (JSON.stringify(oldLlm?.nano) !== JSON.stringify(newLlm?.nano)) return false;
  if (JSON.stringify(oldLlm?.providers) !== JSON.stringify(newLlm?.providers)) return false;

  return true;
}

/** Snapshot of initializeDatabases() return shape for register-plugin when reusing handles. */
export function databaseContextFromRuntime(
  old: PluginRuntime,
  opts?: {
    newBootstrapPromise?: Promise<void>;
    health?: { embeddingsOk: boolean; credentialsVaultOk: boolean; lastCheckTime: number };
  },
) {
  const health = opts?.health ??
    old.bootstrapHealth ?? { embeddingsOk: false, credentialsVaultOk: false, lastCheckTime: Date.now() };
  return {
    factsDb: old.factsDb,
    edictStore: old.edictStore,
    vectorDb: old.vectorDb,
    embeddings: old.embeddings,
    embeddingRegistry: old.embeddingRegistry,
    openai: old.openai,
    credentialsDb: old.credentialsDb,
    wal: old.wal,
    proposalsDb: old.proposalsDb,
    identityReflectionStore: old.identityReflectionStore,
    personaStateStore: old.personaStateStore,
    eventLog: old.eventLog,
    narrativesDb: old.narrativesDb!,
    aliasDb: old.aliasDb,
    issueStore: old.issueStore!,
    workflowStore: old.workflowStore!,
    crystallizationStore: old.crystallizationStore!,
    toolProposalStore: old.toolProposalStore!,
    verificationStore: old.verificationStore,
    provenanceService: old.provenanceService,
    costTracker: old.costTracker,
    resolvedLancePath: old.resolvedLancePath,
    resolvedSqlitePath: old.resolvedSqlitePath,
    apitapStore: old.apitapStore!,
    initialized: opts?.newBootstrapPromise ?? old.bootstrapAsyncInit,
    health,
  };
}
