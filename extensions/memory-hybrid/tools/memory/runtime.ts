import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { FactsDB } from "../../backends/facts-db.js";
import type { VectorDB } from "../../backends/vector-db.js";
import type { MemoryToolsContext } from "./types.js";
import type { sanitizeScopeParam, storeRegistryEmbeddings } from "./helpers.js";

export type MemoryToolRuntime = MemoryToolsContext & {
  api: ClawdbotPluginApi;
  auditAppend: (input: import("../../backends/audit-store.js").AuditEventInput) => void;
  agentIdForAudit: () => string;
  maybeRefreshProjectActiveTaskProjection: (
    factCategory: string,
    factId: string,
    factScope: string | null | undefined,
  ) => Promise<void>;
  storeActiveCanonicalVector: (options: {
    factId: string;
    text: string;
    why?: string | null;
    vector: number[];
    importance: number;
    category: string;
    /** Vault-resolved backends — required so a fact stored in a named vault gets its embedding
     * written to that same vault's LanceDB, not the plugin's default vault (#storage-recall-review). */
    factsDb: FactsDB;
    vectorDb: VectorDB;
  }) => Promise<void>;
  storeRegistryEmbeddings: typeof storeRegistryEmbeddings;
  isEdictWriteToolEnabled: () => boolean;
  sanitizeScopeParam: typeof sanitizeScopeParam;
};
