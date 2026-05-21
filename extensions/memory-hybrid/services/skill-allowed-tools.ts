/**
 * Mine `allowed-tools` for the Skill Creator frontmatter from a procedure recipe.
 *
 * Reduces selection-time noise for the agent (only proposes the skill when the
 * relevant tools are even available) and aligns with the Anthropic best-practices
 * guidance that MCP tool references should be fully qualified (`Server:tool`).
 */

type RecipeStep = Record<string, unknown>;

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z][A-Za-z0-9_-]*)?$/;

/** Extract a deduplicated, sorted set of tool names referenced by a recipe. */
export function extractAllowedTools(recipe: unknown): string[] {
  if (!Array.isArray(recipe)) return [];
  const tools = new Set<string>();
  for (const step of recipe) {
    if (!step || typeof step !== "object") continue;
    const s = step as RecipeStep;
    const raw = typeof s.tool === "string" ? s.tool.trim() : "";
    if (!raw) continue;
    if (!TOOL_NAME_PATTERN.test(raw)) continue;
    tools.add(raw);
  }
  return [...tools].sort();
}

/** Render an `allowed-tools` YAML list. Returns empty string if nothing to render. */
export function renderAllowedToolsYaml(tools: string[]): string {
  if (tools.length === 0) return "";
  const items = tools.map((t) => `  - "${t}"`).join("\n");
  return `allowed-tools:\n${items}`;
}
