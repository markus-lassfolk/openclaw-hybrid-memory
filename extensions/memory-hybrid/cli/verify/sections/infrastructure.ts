
/**
 * CLI Verify Command Handler
 *
 * Contains runVerifyForCli and its private helper functions.
 * Checks infrastructure (SQLite, LanceDB, embeddings, LLM credentials,
 * cron jobs) and optionally applies fixes.
 *
 * Extracted from cli/handlers.ts to keep that file manageable.
 */

import { writeFileSync } from "node:fs";
import { capturePluginError } from "../../../services/error-reporter.js";
import { PLUGIN_ID, } from "../../../utils/constants.js";

import type { VerifyRunState } from "../verify-run-state.js";
import { getCachedFactCount } from "../fact-count.js";

export async function runVerifyInfrastructureSection(state: VerifyRunState): Promise<void> {
  const {
    ctx,
    opts,
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
    OK,
    FAIL,
    PAUSE,
    WARN_LINE,
    noEmoji,
    issues,
    fixes,
    warnings,
    loadBlocking,
    extDir,
    defaultConfigPath,
    openclawDir,
    openclawConfigRead,
    recommendedEmbedding,
    dashboardUrl,
  } = state;

  log("\n───── Infrastructure ─────");

  if (
    cfg.embedding.provider === "openai" &&
    (!cfg.embedding.apiKey || cfg.embedding.apiKey === "YOUR_OPENAI_API_KEY" || cfg.embedding.apiKey.length < 10)
  ) {
    state.issues.push("embedding.apiKey is missing, placeholder, or too short");
    state.loadBlocking.push("embedding.apiKey is missing, placeholder, or too short");
    state.fixes.push(
      `LOAD-BLOCKING: Set plugins.entries["${PLUGIN_ID}"].config.embedding.apiKey to a valid OpenAI key (and embedding.model to "text-embedding-3-small"). Edit ${defaultConfigPath} or set OPENAI_API_KEY and use env:OPENAI_API_KEY in config.`,
    );
    state.configOk = false;
  }
  if (!cfg.embedding.model) {
    state.issues.push("embedding.model is missing");
    state.loadBlocking.push("embedding.model is missing");
    state.fixes.push('Set "embedding.model" to "text-embedding-3-small" or "text-embedding-3-large" in plugin config');
    state.configOk = false;
  }
  if (state.configOk) {
    const msg =
      cfg.embedding.provider === "openai"
        ? "Config: embedding.apiKey and model present"
        : "Config: embedding.model present";
    log(`${OK} ${msg}`);
  } else {
    log(`${FAIL} Config: issues found`);
    const WARN = noEmoji ? "[WARN]" : "⚠️";
    if (state.loadBlocking.some((s) => s.includes("embedding"))) {
      log(
        `${WARN} Embedding: missing or invalid — retrieval and indexing will not work. Set embedding.apiKey and embedding.model in plugin config.`,
      );
      log(
        `  Suggested first setup: openclaw hybrid-mem install (recommended embedding: ${recommendedEmbedding.provider}/${recommendedEmbedding.model} from ${recommendedEmbedding.source}).`,
      );
    }
  }

  // Check for unsupported agents.defaults.pruning config (#105)
  if (openclawConfigRead.root) {
    const agentsDefaults = (openclawConfigRead.root.agents as Record<string, unknown>)?.defaults as
      | Record<string, unknown>
      | undefined;
    if (agentsDefaults != null && "pruning" in agentsDefaults) {
      const WARN = noEmoji ? "[WARN]" : "⚠️";
      log(`${WARN} Config: agents.defaults.pruning is set but not supported by OpenClaw core — it has no effect`);
      log(
        `  Fix: Remove "pruning" from agents.defaults in openclaw.json. Memory pruning is handled automatically by the plugin (every 60 min).`,
      );
      state.issues.push("agents.defaults.pruning is set but unsupported (has no effect)");
      state.fixes.push(
        'Remove "pruning" from agents.defaults in openclaw.json. Memory pruning is handled automatically by the plugin (every 60 min).',
      );
      if (opts.fix) {
        agentsDefaults.pruning = undefined;
        writeFileSync(defaultConfigPath, JSON.stringify(openclawConfigRead.root, null, 2), "utf-8");
        log(`  → Removed agents.defaults.pruning from ${defaultConfigPath}`);
        state.fixes.pop();
        issues.pop();
      }
    }
  }

  const isBindingsError = (msg: string) =>
    /bindings|better_sqlite3\.node|compiled against|ABI|NODE_MODULE_VERSION|@lancedb\/lancedb|Cannot find module/.test(
      msg,
    );
  let _sqliteBindingsFailed = false;
  state.lanceBindingsFailed = false;

  try {
    const n = getCachedFactCount(factsDb, resolvedSqlitePath);
    state.sqliteOk = true;
    log(`${OK} SQLite: OK (${resolvedSqlitePath}, ${n} facts)`);
  } catch (e) {
    const msg = String(e);
    state.issues.push(`SQLite: ${msg}`);
    if (isBindingsError(msg)) {
      _sqliteBindingsFailed = true;
      state.fixes.push("node:sqlite is not available. Upgrade Node.js to >=22.16.0 or use a compatible version.");
    } else {
      state.fixes.push(
        `SQLite: Ensure path is writable and not corrupted. Path: ${resolvedSqlitePath}. If corrupted, back up and remove the file to recreate, or run from a process with write access.`,
      );
    }
    log(`${FAIL} SQLite: FAIL — ${msg}`);
    capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:sqlite-check" });
  }

  try {
    const n = await vectorDb.count();
    state.lanceOk = true;
    log(`${OK} LanceDB: OK (${resolvedLancePath}, ${n} vectors)`);
    const degradedState =
      typeof (vectorDb as { getDegradedState?: unknown }).getDegradedState === "function"
        ? (
            vectorDb as {
              getDegradedState: () => { active: boolean; reason: string | null; sinceEpochMs: number | null };
            }
          ).getDegradedState()
        : { active: false, reason: null as string | null, sinceEpochMs: null as number | null };
    if (degradedState.active) {
      const WARN = noEmoji ? "[WARN]" : "⚠️";
      log(
        `${WARN} LanceDB degraded mode is active${degradedState.reason ? ` (reason=${degradedState.reason})` : ""}. Use 'openclaw hybrid-mem repair-vectors' after connectivity/config fixes.`,
      );
      state.warnings.push(
        `LanceDB degraded mode active${degradedState.reason ? ` (${degradedState.reason})` : ""}; vector retrieval may be unavailable`,
      );
    }
  } catch (e) {
    const msg = String(e);
    state.issues.push(`LanceDB: ${msg}`);
    if (isBindingsError(msg)) {
      state.lanceBindingsFailed = true;
      state.fixes.push(
        `Native module (@lancedb/lancedb) needs rebuild. Run: cd ${extDir} && npm rebuild @lancedb/lancedb`,
      );
    } else if (msg.includes("VectorDB not initialized") || msg.includes("close() was called")) {
      state.fixes.push(
        "LanceDB connection was not ready (often transient after plugin load or reload). Re-run verify; the plugin will reconnect automatically. Not caused by reindexing.",
      );
    } else {
      state.fixes.push(
        `LanceDB: Ensure path is writable. Path: ${resolvedLancePath}. If corrupted, back up and remove the directory to recreate. Restart gateway after fix.`,
      );
    }
    log(`${FAIL} LanceDB: FAIL — ${msg}`);
    capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:lancedb-check" });
  }
}
