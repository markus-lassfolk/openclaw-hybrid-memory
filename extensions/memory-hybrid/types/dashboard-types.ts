/**
 * Shared types for dashboard and agent health monitoring.
 */

export interface ForgeTaskItem {
	agent?: string;
	task: string;
	workdir?: string;
	pid?: number;
	started_at?: string;
	status?: string;
}
