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
  const nextSqlite = api.resolvePath(cfg.sqlitePath);
  const nextLance = api.resolvePath(cfg.lanceDbPath);
  return old.resolvedSqlitePath === nextSqlite && old.resolvedLancePath === nextLance;
}

/** Snapshot of initializeDatabases() return shape for register-plugin when reusing handles. */
export function databaseContextFromRuntime(
  old: PluginRuntime,
  opts?: { newBootstrapPromise?: Promise<void>; health?: { embeddingsOk: boolean; credentialsVaultOk: boolean; lastCheckTime: number } },
) {
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
    health: opts?.health ?? old.health,
  };
}
