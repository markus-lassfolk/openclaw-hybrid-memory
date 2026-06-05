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
   * How often to sync facts to workspace markdown files for bridge import.
   * Only used when publicArtifacts is true.
   * Default: 30 (minutes).
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
