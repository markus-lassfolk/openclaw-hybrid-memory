/**
 * Workboard integration configuration — bidirectional sync of active tasks and goals
 * to OpenClaw's Workboard Kanban UI.
 */

export type WorkboardConfig = {
  /** Master switch for Workboard integration. Default: false. */
  enabled: boolean;
  /**
   * Gateway HTTP base URL for Workboard RPC calls.
   * Default: "http://localhost:9119" (OpenClaw Gateway default).
   */
  gatewayUrl: string;
  /** Sync interval in minutes — how often to reconcile cards. Default: 5. */
  syncIntervalMinutes: number;
  /** Sync active tasks to Workboard. Default: true (when Workboard is enabled). */
  syncTasks: boolean;
  /** Sync goals to Workboard. Default: true (when Workboard is enabled). */
  syncGoals: boolean;
  /**
   * Workboard column mapping — maps hybrid-memory status values to Workboard column names.
   * Set null to skip syncing that status.
   */
  columns: WorkboardColumnMapping;
  /**
   * Whether to accept Workboard card moves (status changes) back into hybrid-memory.
   * Requires mutations.enabled in wiki integration or standalone fact mutation support.
   * Default: true (when Workboard is enabled).
   */
  bidirectional: boolean;
  /**
   * Tag to apply to Workboard cards created by hybrid-memory for filtering.
   * Default: "hybrid-memory".
   */
  cardTag: string;
};

export type WorkboardColumnMapping = {
  taskInProgress: string;
  taskDone: string;
  taskFailed: string | null;
  taskStale: string | null;
  taskParked: string | null;
  goalActive: string;
  goalBlocked: string | null;
  goalStalled: string | null;
  goalCompleted: string;
};

export const DEFAULT_WORKBOARD_COLUMNS: WorkboardColumnMapping = {
  taskInProgress: "In Progress",
  taskDone: "Done",
  taskFailed: "Failed",
  taskStale: "Backlog",
  taskParked: "Backlog",
  goalActive: "In Progress",
  goalBlocked: "Blocked",
  goalStalled: "Backlog",
  goalCompleted: "Done",
};

export const DEFAULT_WORKBOARD_CONFIG: WorkboardConfig = {
  enabled: false,
  gatewayUrl: "http://localhost:9119",
  syncIntervalMinutes: 5,
  syncTasks: true,
  syncGoals: true,
  columns: DEFAULT_WORKBOARD_COLUMNS,
  bidirectional: true,
  cardTag: "hybrid-memory",
};
