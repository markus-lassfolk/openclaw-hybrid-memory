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
  /**
   * Count of registrations that opened fresh databases even though the prior teardown had not
   * finished draining within the wait budget (#2111). A non-zero value indicates the reload
   * gate is recovering from slow teardowns rather than failing plugin initialization.
   */
  teardownTimeoutRecoveries: number;
};

export const reregisterMetrics: ReregisterMetrics = {
  policy: "(unset)",
  registrations: 0,
  fullTeardowns: 0,
  databaseReuses: 0,
  teardownTimeoutRecoveries: 0,
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
  reregisterMetrics.teardownTimeoutRecoveries = 0;
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

export function recordReregisterTeardownTimeoutRecovery(): void {
  reregisterMetrics.teardownTimeoutRecoveries += 1;
}

type PathResolvingApi = { resolvePath: (p: string) => string };

function booleanMethod(target: unknown, method: string): boolean | null {
  if (!target || typeof target !== "object") return null;
  const fn = (target as Record<string, unknown>)[method];
  if (typeof fn !== "function") return null;
  try {
    const value = fn.call(target);
    return typeof value === "boolean" ? value : null;
  } catch {
    return false;
  }
}

function isReusableStoreOpen(target: unknown): boolean {
  const isOpen = booleanMethod(target, "isOpen");
  if (isOpen === false) return false;
  const isInitialized = booleanMethod(target, "isInitialized");
  if (isInitialized === false) return false;
  const lanceAvailable = booleanMethod(target, "isLanceDbAvailable");
  if (lanceAvailable === false) return false;
  return true;
}

function runtimeStoresStillReusable(old: PluginRuntime): boolean {
  const requiredStores: Array<[string, unknown]> = [
    ["factsDb", old.factsDb],
    ["edictStore", old.edictStore],
    ["vectorDb", old.vectorDb],
    ["proposalsDb", old.proposalsDb],
    ["narrativesDb", old.narrativesDb],
    ["aliasDb", old.aliasDb],
    ["issueStore", old.issueStore],
    ["workflowStore", old.workflowStore],
    ["crystallizationStore", old.crystallizationStore],
    ["toolProposalStore", old.toolProposalStore],
    ["verificationStore", old.verificationStore],
    ["apitapStore", old.apitapStore],
  ];
  for (const [, store] of requiredStores) {
    if (store && !isReusableStoreOpen(store)) return false;
  }
  if (old.cfg.credentials?.enabled && old.credentialsDb && !isReusableStoreOpen(old.credentialsDb)) {
    return false;
  }
  if (old.wal && !isReusableStoreOpen(old.wal)) return false;
  return true;
}

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
  // A settled donor can still be unusable if teardown/shutdown already closed one of its
  // SQLite/Lance handles. Reusing such a donor poisons the new registration: tools,
  // Workboard sync, credentials checks, compaction hooks, and lifecycle hooks inherit
  // stores that immediately throw "The database connection is not open". Treat any
  // closed/failed donor handle as non-reusable and fall back to a full fresh open.
  if (!runtimeStoresStillReusable(old)) return false;
  const nextSqlite = api.resolvePath(cfg.sqlitePath);
  const nextLance = api.resolvePath(cfg.lanceDbPath);
  if (old.resolvedSqlitePath !== nextSqlite || old.resolvedLancePath !== nextLance) return false;

  // Compare parse-time config, not bootstrap-mutated runtime cfg (initializeDatabases may inject llm tiers).
  const oldCfg = old.parsedCfgSnapshot ?? old.cfg;
  if (!oldCfg?.embedding || !cfg.embedding) return false;
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

  // Compare credentials.enabled to detect when vault should be opened or closed.
  if (oldCfg.credentials?.enabled !== cfg.credentials?.enabled) return false;
  // encryptionKey is non-enumerable on parsed config. A cloned snapshot can lose the key,
  // so fall back to the donor runtime cfg before treating missing as empty. Otherwise a
  // hot reload from a valid key to a missing/empty key could incorrectly reuse the old
  // CredentialsDB and keep decrypted credentials accessible until process restart.
  const oldEncKey = oldCfg.credentials?.encryptionKey ?? old.cfg.credentials?.encryptionKey ?? "";
  const newEncKey = cfg.credentials?.encryptionKey ?? "";
  if (oldEncKey !== newEncKey) return false;

  // Compare HTTP route security settings so auth hardening or route disablement
  // cannot keep stale public/dashboard handlers alive on reused database handles.
  if (oldCfg.health?.enabled !== cfg.health?.enabled) return false;
  if (oldCfg.health?.authenticated !== cfg.health?.authenticated) return false;

  // Compare every flag that gates a conditionally-constructed store in bootstrap-optional.ts.
  // Without this, flipping one of these on/off in config has no effect on a reuse-databases
  // reload — the donor's store handle (often still null) is carried over unchanged, so the
  // feature silently stays off (or, for wal.enabled, writes silently keep bypassing WAL) until
  // some unrelated field forces a full teardown.
  if (oldCfg.wal?.enabled !== cfg.wal?.enabled) return false;
  if (oldCfg.personaProposals?.enabled !== cfg.personaProposals?.enabled) return false;
  if (oldCfg.identityReflection?.enabled !== cfg.identityReflection?.enabled) return false;
  if (oldCfg.identityPromotion?.enabled !== cfg.identityPromotion?.enabled) return false;
  if (oldCfg.nightlyCycle?.enabled !== cfg.nightlyCycle?.enabled) return false;
  if (oldCfg.graph?.autoSupersede !== cfg.graph?.autoSupersede) return false;
  if (oldCfg.passiveObserver?.enabled !== cfg.passiveObserver?.enabled) return false;
  if (oldCfg.aliases?.enabled !== cfg.aliases?.enabled) return false;
  if (oldCfg.verification?.enabled !== cfg.verification?.enabled) return false;
  if (oldCfg.provenance?.enabled !== cfg.provenance?.enabled) return false;

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
