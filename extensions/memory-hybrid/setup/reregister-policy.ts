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
  /**
   * Per-reason breakdown of why full teardowns happened, keyed by a stable reason code (#2136).
   * Under `reuse-databases` this is what turns an unexplained `fullTeardowns > 0` into an
   * actionable diagnostic ("bootstrap_not_settled" vs "config_drift:embedding.model" vs
   * "teardown_soft_timeout" …) so operators can tell an intentional teardown from a policy
   * violation without reading source.
   */
  fullTeardownReasons: Record<string, number>;
};

export const reregisterMetrics: ReregisterMetrics = {
  policy: "(unset)",
  registrations: 0,
  fullTeardowns: 0,
  databaseReuses: 0,
  teardownTimeoutRecoveries: 0,
  fullTeardownReasons: {},
};

/**
 * Structured result of the reuse-vs-teardown decision. `reason` is a stable, low-cardinality code
 * (e.g. `reusable`, `no_donor`, `policy_not_reuse`, `bootstrap_not_settled`, `donor_handle_closed`,
 * `sqlite_path_changed`, `config_drift:<field>`) so it can be counted and surfaced in diagnostics.
 */
export type ReregisterReuseDecision = { reuse: boolean; reason: string };

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
  reregisterMetrics.fullTeardownReasons = {};
}

export function recordReregisterRegistration(): void {
  resolveReregisterPolicy();
  reregisterMetrics.registrations += 1;
}

/**
 * Record a full teardown and, when known, why it happened. The `reason` is a stable code (see
 * {@link ReregisterReuseDecision}); it is tallied in `fullTeardownReasons` so diagnostics can
 * explain each teardown instead of leaving an unattributed `fullTeardowns` counter (#2136).
 */
export function recordReregisterFullTeardown(reason?: string): void {
  reregisterMetrics.fullTeardowns += 1;
  const key = reason?.trim() ? reason.trim() : "unspecified";
  reregisterMetrics.fullTeardownReasons[key] = (reregisterMetrics.fullTeardownReasons[key] ?? 0) + 1;
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
    ["serendipityStore", old.serendipityStore],
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

const REUSABLE: ReregisterReuseDecision = { reuse: true, reason: "reusable" };
const drift = (field: string): ReregisterReuseDecision => ({ reuse: false, reason: `config_drift:${field}` });

/**
 * Decide whether a re-register may keep the donor's SQLite/Lance handles, returning a stable
 * reason code alongside the boolean (#2136). Every decline path names why it declined so a full
 * teardown under `reuse-databases` is never unexplained. Pure/side-effect-free — callers record
 * the reason via {@link recordReregisterFullTeardown}.
 */
export function evaluateReregisterReuse(
  old: PluginRuntime | null,
  cfg: HybridMemoryConfig,
  api: PathResolvingApi,
): ReregisterReuseDecision {
  if (!old) return { reuse: false, reason: "no_donor" };
  if (resolveReregisterPolicy() !== "reuse-databases") return { reuse: false, reason: "policy_not_reuse" };
  // Reuse only after donor bootstrap has fully settled. If bootstrap is still in flight when
  // generation bumps, supersession can skip one-shot init work (vault/migration checks).
  if (old.bootstrapSettledRef?.value !== true) {
    return { reuse: false, reason: "bootstrap_not_settled" };
  }
  // A settled donor can still be unusable if teardown/shutdown already closed one of its
  // SQLite/Lance handles. Reusing such a donor poisons the new registration: tools,
  // Workboard sync, credentials checks, compaction hooks, and lifecycle hooks inherit
  // stores that immediately throw "The database connection is not open". Treat any
  // closed/failed donor handle as non-reusable and fall back to a full fresh open.
  if (!runtimeStoresStillReusable(old)) return { reuse: false, reason: "donor_handle_closed" };
  const nextSqlite = api.resolvePath(cfg.sqlitePath);
  const nextLance = api.resolvePath(cfg.lanceDbPath);
  if (old.resolvedSqlitePath !== nextSqlite) return { reuse: false, reason: "sqlite_path_changed" };
  if (old.resolvedLancePath !== nextLance) return { reuse: false, reason: "lance_path_changed" };

  // Compare parse-time config, not bootstrap-mutated runtime cfg (initializeDatabases may inject llm tiers).
  const oldCfg = old.parsedCfgSnapshot ?? old.cfg;
  if (!oldCfg?.embedding || !cfg.embedding) return drift("embedding.missing");
  if (oldCfg.embedding.provider !== cfg.embedding.provider) return drift("embedding.provider");
  if (oldCfg.embedding.model !== cfg.embedding.model) return drift("embedding.model");
  if (oldCfg.embedding.endpoint !== cfg.embedding.endpoint) return drift("embedding.endpoint");
  if (oldCfg.embedding.apiKey !== cfg.embedding.apiKey) return drift("embedding.apiKey");
  if (oldCfg.embedding.deployment !== cfg.embedding.deployment) return drift("embedding.deployment");

  // Compare LLM config to detect model/provider changes that require rebuilding openai client
  const oldLlm = oldCfg.llm;
  const newLlm = cfg.llm;
  if (JSON.stringify(oldLlm?.default) !== JSON.stringify(newLlm?.default)) return drift("llm.default");
  if (JSON.stringify(oldLlm?.heavy) !== JSON.stringify(newLlm?.heavy)) return drift("llm.heavy");
  if (JSON.stringify(oldLlm?.nano) !== JSON.stringify(newLlm?.nano)) return drift("llm.nano");
  if (JSON.stringify(oldLlm?.providers) !== JSON.stringify(newLlm?.providers)) return drift("llm.providers");

  // Compare credentials.enabled to detect when vault should be opened or closed.
  if (oldCfg.credentials?.enabled !== cfg.credentials?.enabled) return drift("credentials.enabled");
  // encryptionKey is non-enumerable on parsed config. A cloned snapshot can lose the key,
  // so fall back to the donor runtime cfg before treating missing as empty. Otherwise a
  // hot reload from a valid key to a missing/empty key could incorrectly reuse the old
  // CredentialsDB and keep decrypted credentials accessible until process restart.
  const oldEncKey = oldCfg.credentials?.encryptionKey ?? old.cfg.credentials?.encryptionKey ?? "";
  const newEncKey = cfg.credentials?.encryptionKey ?? "";
  if (oldEncKey !== newEncKey) return drift("credentials.encryptionKey");

  // Compare HTTP route security settings so auth hardening or route disablement
  // cannot keep stale public/dashboard handlers alive on reused database handles.
  if (oldCfg.health?.enabled !== cfg.health?.enabled) return drift("health.enabled");
  if (oldCfg.health?.authenticated !== cfg.health?.authenticated) return drift("health.authenticated");

  // Compare every flag that gates a conditionally-constructed store in bootstrap-optional.ts.
  // Without this, flipping one of these on/off in config has no effect on a reuse-databases
  // reload — the donor's store handle (often still null) is carried over unchanged, so the
  // feature silently stays off (or, for wal.enabled, writes silently keep bypassing WAL) until
  // some unrelated field forces a full teardown.
  if (oldCfg.wal?.enabled !== cfg.wal?.enabled) return drift("wal.enabled");
  if (oldCfg.personaProposals?.enabled !== cfg.personaProposals?.enabled) return drift("personaProposals.enabled");
  if (oldCfg.identityReflection?.enabled !== cfg.identityReflection?.enabled)
    return drift("identityReflection.enabled");
  if (oldCfg.identityPromotion?.enabled !== cfg.identityPromotion?.enabled) return drift("identityPromotion.enabled");
  if (oldCfg.nightlyCycle?.enabled !== cfg.nightlyCycle?.enabled) return drift("nightlyCycle.enabled");
  if (oldCfg.graph?.autoSupersede !== cfg.graph?.autoSupersede) return drift("graph.autoSupersede");
  if (oldCfg.passiveObserver?.enabled !== cfg.passiveObserver?.enabled) return drift("passiveObserver.enabled");
  if (oldCfg.aliases?.enabled !== cfg.aliases?.enabled) return drift("aliases.enabled");
  if (oldCfg.verification?.enabled !== cfg.verification?.enabled) return drift("verification.enabled");
  if (oldCfg.provenance?.enabled !== cfg.provenance?.enabled) return drift("provenance.enabled");

  return REUSABLE;
}

/** True when re-register may keep existing SQLite/Lance handles (paths unchanged). */
export function canReuseDatabasesOnReregister(
  old: PluginRuntime | null,
  cfg: HybridMemoryConfig,
  api: PathResolvingApi,
): boolean {
  return evaluateReregisterReuse(old, cfg, api).reuse;
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
    serendipityStore: old.serendipityStore ?? null,
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
