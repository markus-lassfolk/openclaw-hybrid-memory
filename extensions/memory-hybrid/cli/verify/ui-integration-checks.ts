/**
 * Pure checks for wiki / workboard integration verify output.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HybridMemoryConfig } from "../../config.js";
import { WIKI_WORKSPACE_EXPORT_SUBDIR } from "../../services/wiki-workspace-export.js";
import { createWorkboardHttpRpcClient } from "../../services/workboard-rpc-client.js";
import { isWikiExportableFact } from "../../services/wiki-fact-filter.js";
import type { FactsDB } from "../../backends/facts-db.js";

export type WikiMirrorInspectResult = {
  enabled: boolean;
  intervalMinutes: number;
  exportRoot: string;
  directoryExists: boolean;
  markdownFileCount: number;
  lastSyncedAt: string | null;
  lastSyncFactCount: number | null;
  exportableFactCount: number;
};

export type WorkboardProbeResult = {
  ok: boolean;
  gatewayUrl: string;
  error?: string;
};

function countMarkdownFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      count += countMarkdownFiles(full);
    } else if (name.endsWith(".md")) {
      count++;
    }
  }
  return count;
}

export function inspectWikiWorkspaceMirror(
  cfg: HybridMemoryConfig,
  workspaceRoot: string,
  factsDb: FactsDB,
): WikiMirrorInspectResult {
  const intervalMinutes = cfg.wikiIntegration?.workspaceExportIntervalMinutes ?? 0;
  const exportRoot = join(workspaceRoot, WIKI_WORKSPACE_EXPORT_SUBDIR);
  const exportableFactCount = factsDb.getAll({ includeSuperseded: false }).filter(isWikiExportableFact).length;

  let lastSyncedAt: string | null = null;
  let lastSyncFactCount: number | null = null;
  const syncMetaPath = join(exportRoot, ".hybrid-wiki-sync.json");
  if (existsSync(syncMetaPath)) {
    try {
      const meta = JSON.parse(readFileSync(syncMetaPath, "utf-8")) as {
        syncedAt?: string;
        factCount?: number;
      };
      lastSyncedAt = typeof meta.syncedAt === "string" ? meta.syncedAt : null;
      lastSyncFactCount = typeof meta.factCount === "number" ? meta.factCount : null;
    } catch {
      // ignore corrupt meta
    }
  }

  return {
    enabled: cfg.wikiIntegration?.enabled === true && intervalMinutes > 0,
    intervalMinutes,
    exportRoot,
    directoryExists: existsSync(exportRoot),
    markdownFileCount: countMarkdownFiles(exportRoot),
    lastSyncedAt,
    lastSyncFactCount,
    exportableFactCount,
  };
}

export async function probeWorkboardRpc(gatewayUrl: string, token?: string): Promise<WorkboardProbeResult> {
  const client = createWorkboardHttpRpcClient(gatewayUrl, token);
  try {
    const ok = await client.isAvailable();
    return ok
      ? { ok: true, gatewayUrl }
      : { ok: false, gatewayUrl, error: "Gateway RPC probe failed (workboard.cards.list)" };
  } catch (err) {
    return {
      ok: false,
      gatewayUrl,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
