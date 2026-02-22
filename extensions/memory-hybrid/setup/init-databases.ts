import { dirname, join } from "node:path";
import { existsSync, readFileSync, constants } from "node:fs";
import { open } from "node:fs/promises";
import OpenAI from "openai";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { FactsDB } from "../backends/facts-db.js";
import { VectorDB } from "../backends/vector-db.js";
import { CredentialsDB } from "../backends/credentials-db.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { WriteAheadLog } from "../backends/wal.js";
import { Embeddings } from "../services/embeddings.js";
import { vectorDimsForModel, type HybridMemoryConfig, type CredentialType } from "../config.js";
import { setKeywordsPath } from "../utils/language-keywords.js";
import { setMemoryCategories, getMemoryCategories } from "../config.js";
import { migrateCredentialsToVault, CREDENTIAL_REDACTION_MIGRATION_FLAG } from "../services/credential-migration.js";
import { capturePluginError } from "../services/error-reporter.js";

export interface HealthStatus {
  embeddingsOk: boolean;
  credentialsVaultOk: boolean;
  lastCheckTime: number;
}

export interface DatabaseContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: Embeddings;
  openai: OpenAI;
  credentialsDb: CredentialsDB | null;
  wal: WriteAheadLog | null;
  proposalsDb: ProposalsDB | null;
  resolvedLancePath: string;
  resolvedSqlitePath: string;
  health: HealthStatus;
}

/**
 * Initializes all databases and services for the plugin.
 *
 * This includes:
 * - FactsDB (SQLite)
 * - VectorDB (LanceDB)
 * - Embeddings service
 * - OpenAI client
 * - CredentialsDB (optional)
 * - WriteAheadLog (optional)
 * - ProposalsDB (optional)
 * - Discovered categories loading
 * - Async verification checks
 */
export function initializeDatabases(
  cfg: HybridMemoryConfig,
  api: ClawdbotPluginApi,
): DatabaseContext {
  const resolvedLancePath = api.resolvePath(cfg.lanceDbPath);
  const resolvedSqlitePath = api.resolvePath(cfg.sqlitePath);
  setKeywordsPath(dirname(resolvedSqlitePath));
  const vectorDim = vectorDimsForModel(cfg.embedding.model);

  const factsDb = new FactsDB(resolvedSqlitePath, { fuzzyDedupe: cfg.store.fuzzyDedupe });
  const vectorDb = new VectorDB(resolvedLancePath, vectorDim);
  vectorDb.setLogger(api.logger);
  // Use gateway-proxied OpenAI client when running inside the gateway (option 2: env-based discovery)
  const gatewayPortRaw = process.env.OPENCLAW_GATEWAY_PORT;
  const gatewayPortNum = gatewayPortRaw !== undefined ? parseInt(gatewayPortRaw, 10) : NaN;
  const gatewayPort = !isNaN(gatewayPortNum) && gatewayPortNum >= 1 && gatewayPortNum <= 65535 ? gatewayPortNum : undefined;
  if (gatewayPortRaw !== undefined && gatewayPort === undefined) {
    api.logger.warn?.(`memory-hybrid: OPENCLAW_GATEWAY_PORT "${gatewayPortRaw}" is not a valid port number (1-65535); gateway base URL not used`);
  }
  const gatewayBaseUrl = gatewayPort !== undefined ? `http://127.0.0.1:${gatewayPort}/v1` : undefined;
  const openai = new OpenAI({ apiKey: cfg.embedding.apiKey, ...(gatewayBaseUrl ? { baseURL: gatewayBaseUrl } : {}) });
  const embeddingModels = cfg.embedding.models?.length ? cfg.embedding.models : [cfg.embedding.model];
  const embeddings = new Embeddings(openai, embeddingModels);

  let credentialsDb: CredentialsDB | null = null;
  if (cfg.credentials.enabled) {
    const credPath = join(dirname(resolvedSqlitePath), "credentials.db");
    credentialsDb = new CredentialsDB(credPath, cfg.credentials.encryptionKey ?? "");
    const encrypted = (cfg.credentials.encryptionKey?.length ?? 0) >= 16;
    api.logger.info(
      encrypted
        ? `memory-hybrid: credentials vault enabled (encrypted) (${credPath})`
        : `memory-hybrid: credentials vault enabled (plaintext; secure by other means) (${credPath})`
    );
  }

  // Initialize Write-Ahead Log for crash resilience
  let wal: WriteAheadLog | null = null;
  if (cfg.wal.enabled) {
    const walPath = cfg.wal.walPath || join(dirname(resolvedSqlitePath), "memory.wal");
    wal = new WriteAheadLog(walPath, cfg.wal.maxAge);
    api.logger.info(`memory-hybrid: WAL enabled (${walPath})`);
  }

  let proposalsDb: ProposalsDB | null = null;
  if (cfg.personaProposals.enabled) {
    const proposalsPath = join(dirname(resolvedSqlitePath), "proposals.db");
    proposalsDb = new ProposalsDB(proposalsPath);
    api.logger.info(`memory-hybrid: persona proposals enabled (${proposalsPath})`);
  }

  // Load previously discovered categories so they remain available after restart
  const discoveredPath = join(dirname(resolvedSqlitePath), ".discovered-categories.json");
  if (existsSync(discoveredPath)) {
    try {
      const loaded = JSON.parse(readFileSync(discoveredPath, "utf-8")) as string[];
      if (Array.isArray(loaded) && loaded.length > 0) {
        setMemoryCategories([...getMemoryCategories(), ...loaded]);
        api.logger.info(`memory-hybrid: loaded ${loaded.length} discovered categories`);
      }
    } catch (err) {
      api.logger.warn(`memory-hybrid: failed to load discovered categories: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "load-discovered-categories",
        subsystem: "config",
      });
    }
  }

  // Health status tracking for verification checks
  const health: HealthStatus = {
    embeddingsOk: false,
    credentialsVaultOk: false,
    lastCheckTime: Date.now(),
  };

  // Prerequisite checks (async, don't block plugin start): verify keys and model access
  // Health status can be queried by tools to fail gracefully instead of throwing at runtime.
  void (async () => {
    try {
      await embeddings.embed("verify");
      health.embeddingsOk = true;
      api.logger.info("memory-hybrid: embedding API check OK");
    } catch (e) {
      capturePluginError(e instanceof Error ? e : new Error(String(e)), {
        subsystem: "embeddings",
        operation: "init-verify",
        phase: "initialization",
        backend: "openai",
      });
      api.logger.error(
        `memory-hybrid: ⚠️  EMBEDDING API CHECK FAILED — ${String(e)}. ` +
          "Plugin will continue but semantic search will not work. " +
          "Set a valid embedding.apiKey in plugin config and ensure the model is accessible. Run 'openclaw hybrid-mem verify' for details.",
      );
    }
    if (cfg.credentials.enabled && credentialsDb) {
      try {
        const items = credentialsDb.list();
        if (items.length > 0) {
          const first = items[0];
          credentialsDb.get(first.service, first.type as CredentialType);
        }
        health.credentialsVaultOk = true;
        api.logger.info("memory-hybrid: credentials vault check OK");
      } catch (e) {
        capturePluginError(e instanceof Error ? e : new Error(String(e)), {
          subsystem: "credentials",
          operation: "vault-verify",
          phase: "initialization",
          backend: "sqlite",
        });
        api.logger.error(
          `memory-hybrid: ⚠️  CREDENTIALS VAULT CHECK FAILED — ${String(e)}. ` +
            "Plugin will continue but credential storage will not work. " +
            "Check OPENCLAW_CRED_KEY (or credentials.encryptionKey). Wrong key or corrupted DB. Run 'openclaw hybrid-mem verify' for details.",
        );
      }
      // When vault is enabled: once per install, move existing credential facts into vault and redact from memory
      const migrationFlagPath = join(dirname(resolvedSqlitePath), CREDENTIAL_REDACTION_MIGRATION_FLAG);
      // Atomic flag creation to prevent race condition with multiple processes
      let shouldMigrate = false;
      try {
        const handle = await open(migrationFlagPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        await handle.writeFile("1", "utf8");
        await handle.close();
        shouldMigrate = true; // We won the race, proceed with migration
      } catch (err: any) {
        if (err.code === "EEXIST") {
          // Another process already created the flag - skip migration
          shouldMigrate = false;
        } else {
          throw err; // Unexpected error
        }
      }
      if (shouldMigrate) {
        try {
          const result = await migrateCredentialsToVault({
            factsDb,
            vectorDb,
            embeddings,
            credentialsDb,
            migrationFlagPath,
            markDone: false, // Flag already created atomically above
          });
          if (result.migrated > 0) {
            api.logger.info(`memory-hybrid: migrated ${result.migrated} credential(s) from memory into vault`);
          }
          if (result.errors.length > 0) {
            api.logger.warn(`memory-hybrid: credential migration had ${result.errors.length} error(s): ${result.errors.join("; ")}`);
          }
        } catch (e) {
          capturePluginError(e instanceof Error ? e : new Error(String(e)), {
            subsystem: "credentials",
            operation: "migration-to-vault",
            phase: "initialization",
            backend: "sqlite",
          });
          api.logger.warn(`memory-hybrid: credential migration failed: ${e}`);
        }
      }
    }
  })();

  return {
    factsDb,
    vectorDb,
    embeddings,
    openai,
    credentialsDb,
    wal,
    proposalsDb,
    resolvedLancePath,
    resolvedSqlitePath,
    health,
  };
}

/**
 * Closes old database instances before reinitializing.
 * Used when the plugin is reloaded (e.g., on SIGUSR1 signal).
 */
export function closeOldDatabases(context: {
  factsDb?: FactsDB | null;
  vectorDb?: VectorDB | null;
  credentialsDb?: CredentialsDB | null;
  proposalsDb?: ProposalsDB | null;
}): void {
  const { factsDb, vectorDb, credentialsDb, proposalsDb } = context;

  if (typeof factsDb?.close === "function") {
    try {
      factsDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "factsDb" });
    }
  }
  if (typeof vectorDb?.close === "function") {
    try {
      vectorDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "vectorDb" });
    }
  }
  if (credentialsDb) {
    try {
      credentialsDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "credentialsDb" });
    }
  }
  if (proposalsDb) {
    try {
      proposalsDb.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "close-databases", subsystem: "proposalsDb" });
    }
  }
}
