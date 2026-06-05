/**
 * Wiki integration configuration — memory-wiki bridge, corpus supplement,
 * and bidirectional fact editing.
 */

export type WikiIntegrationConfig = {
  /** Master switch for wiki integration features. Default: false. */
  enabled: boolean;
  /**
   * Register publicArtifacts via registerMemoryCapability so memory-wiki
   * bridge import can discover hybrid-memory facts and dream reports.
   * Default: true (when wiki integration is enabled).
   */
  publicArtifacts: boolean;
  /**
   * Register a MemoryCorpusSupplement so `memory_search corpus=all` and
   * `wiki_search corpus=all` include hybrid-memory facts.
   * Default: true (when wiki integration is enabled).
   */
  corpusSupplement: boolean;
  /**
   * Optional workspace markdown mirror interval (minutes).
   * Writes facts to `{workspace}/memory/hybrid-wiki/` for human browsing and file-based
   * wiki import fallback. Primary bridge path is `publicArtifacts` RPC — set to `0` to disable.
   * Default: 30 (when wiki integration is enabled).
   */
  workspaceExportIntervalMinutes: number;
  /** Fact mutation endpoints (gateway RPC + HTTP) for bidirectional editing. */
  mutations: {
    /** Enable fact mutation endpoints. Default: false. */
    enabled: boolean;
  };
};

export const DEFAULT_WIKI_INTEGRATION_CONFIG: WikiIntegrationConfig = {
  enabled: false,
  publicArtifacts: true,
  corpusSupplement: true,
  workspaceExportIntervalMinutes: 30,
  mutations: {
    enabled: false,
  },
};
