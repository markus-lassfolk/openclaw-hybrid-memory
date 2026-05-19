import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
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
  }) => Promise<void>;
  storeRegistryEmbeddings: typeof storeRegistryEmbeddings;
  isEdictWriteToolEnabled: () => boolean;
  sanitizeScopeParam: typeof sanitizeScopeParam;
};
