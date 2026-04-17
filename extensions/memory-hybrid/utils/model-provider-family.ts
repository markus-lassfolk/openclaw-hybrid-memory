/**
 * Extract the provider family (first path segment) from an OpenClaw / gateway model id.
 * Used to compare cron job models with `agents.defaults.model.primary` (issue #965).
 *
 * Examples: `azure-foundry/gpt-5.4` → `azure-foundry`, `google/gemini-2.5-flash` → `google`,
 * `gemini-2.0-flash` (no slash) → `gemini-2.0-flash`.
 */
export function inferModelProviderPrefix(model: string): string {
	const t = model.trim();
	if (!t) return "";
	const slash = t.indexOf("/");
	if (slash === -1) return t.toLowerCase();
	return t.slice(0, slash).toLowerCase();
}
