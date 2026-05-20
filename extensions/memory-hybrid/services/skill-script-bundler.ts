/**
 * Bundle scripts/replay.sh for deterministic exec-heavy recipes.
 */

type RecipeStep = Record<string, unknown>;

const EXEC_TOOLS = new Set(["exec", "bash", "shell", "sessions_spawn"]);

function extractExecCommands(recipe: unknown): string[] {
  if (!Array.isArray(recipe)) return [];
  const cmds: string[] = [];
  for (const step of recipe) {
    if (!step || typeof step !== "object") continue;
    const s = step as RecipeStep;
    const tool = typeof s.tool === "string" ? s.tool.toLowerCase() : "";
    if (!EXEC_TOOLS.has(tool)) continue;
    const args = s.args;
    if (args && typeof args === "object" && typeof (args as Record<string, unknown>).command === "string") {
      const cmd = String((args as Record<string, unknown>).command).trim();
      if (cmd.length > 0 && cmd.length < 500) cmds.push(cmd);
    } else if (typeof s.summary === "string" && s.summary.length < 200) {
      cmds.push(`# ${s.summary}`);
    }
  }
  return cmds;
}

/**
 * Emit replay.sh when recipe has 1–5 repeatable exec commands (not heterogeneous read-only).
 */
export function maybeBundleReplayScript(recipe: unknown): string | null {
  const cmds = extractExecCommands(recipe);
  if (cmds.length === 0 || cmds.length > 5) return null;
  const readOnlyOnly =
    Array.isArray(recipe) &&
    recipe.every((s) => {
      if (!s || typeof s !== "object") return true;
      const t = String((s as RecipeStep).tool ?? "").toLowerCase();
      return t === "read" || t === "memory_recall" || t === "memory_search" || t === "";
    });
  if (readOnlyOnly) return null;

  const body = cmds
    .map((c, i) => {
      if (c.startsWith("#")) return `echo "Step ${i + 1}: ${c.slice(2).trim()}"`;
      const escaped = c.replace(/'/g, `'\\''`);
      return `echo "Step ${i + 1}: ${c}"\n${c.includes("&&") || c.includes(";") ? c : `bash -lc '${escaped}'`}`;
    })
    .join("\n");

  return `#!/usr/bin/env bash
# Validated workflow replay — generated from procedural memory.
# Run from workspace root. Exits non-zero on first failing step.
set -euo pipefail

${body}

echo "All replay steps completed."
`;
}
