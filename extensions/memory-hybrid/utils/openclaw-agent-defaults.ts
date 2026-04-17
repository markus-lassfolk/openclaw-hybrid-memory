/**
 * Read OpenClaw gateway `agents.defaults.model.primary` from parsed config.
 * Used so hybrid-mem cron job `model` matches agent-bound live sessions (issues #963, #965).
 */
import { existsSync, readFileSync } from "node:fs";

export function readAgentsPrimaryModelFromOpenclawJsonRoot(
	root: Record<string, unknown>,
): string | undefined {
	const modelCfg = (root.agents as Record<string, unknown> | undefined)
		?.defaults as Record<string, unknown> | undefined;
	const m = modelCfg?.model as Record<string, unknown> | undefined;
	return typeof m?.primary === "string" ? m.primary.trim() : undefined;
}

/**
 * Prefer `agents.list` entry with `id === "main"` when set; else `agents.defaults.model.primary` (#963).
 * Isolated cron runs with `agentId` may follow the main agent model rather than defaults only.
 */
export function readEffectiveAgentChatPrimaryFromOpenclawJsonRoot(
	root: Record<string, unknown>,
): string | undefined {
	const agents = root.agents as Record<string, unknown> | undefined;
	const list = agents?.list;
	if (Array.isArray(list)) {
		for (const entry of list) {
			if (entry && typeof entry === "object" && entry !== null) {
				const o = entry as Record<string, unknown>;
				if (o.id === "main") {
					const m = o.model as Record<string, unknown> | undefined;
					if (typeof m?.primary === "string" && m.primary.trim())
						return m.primary.trim();
				}
			}
		}
	}
	return readAgentsPrimaryModelFromOpenclawJsonRoot(root);
}

/** Load `~/.openclaw/openclaw.json` and return `agents.defaults.model.primary` when set. */
export function readAgentsPrimaryModelFromOpenclawJsonPath(
	configPath: string,
): string | undefined {
	if (!existsSync(configPath)) return undefined;
	try {
		const raw = readFileSync(configPath, "utf-8");
		const root = JSON.parse(raw) as Record<string, unknown>;
		return readAgentsPrimaryModelFromOpenclawJsonRoot(root);
	} catch {
		return undefined;
	}
}

/** Cron store may use top-level `model` or `payload.model` depending on OpenClaw version. */
export function extractCronStoreJobModel(
	job: Record<string, unknown>,
): string | undefined {
	if (typeof job.model === "string" && job.model.trim())
		return job.model.trim();
	const payload = job.payload as Record<string, unknown> | undefined;
	if (payload && typeof payload.model === "string" && payload.model.trim())
		return payload.model.trim();
	return undefined;
}

/** Set both top-level and payload model for OpenClaw cron job records. */
export function setCronStoreJobModelFields(
	job: Record<string, unknown>,
	model: string,
): void {
	job.model = model;
	const p = job.payload;
	if (p && typeof p === "object" && p !== null) {
		(p as Record<string, unknown>).model = model;
	}
}
