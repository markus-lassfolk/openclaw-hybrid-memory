/**
 * Bundle scripts/replay.sh for deterministic exec-heavy recipes.
 */

type RecipeStep = Record<string, unknown>;

const EXEC_TOOLS = new Set(["exec", "bash", "shell", "sessions_spawn"]);

function escapeForEcho(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

function shellSingleQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

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
      if (c.startsWith("#")) return `echo "Step ${i + 1}: ${escapeForEcho(c.slice(2).trim())}"`;
      return `echo "Step ${i + 1}: ${escapeForEcho(c)}"\nbash -lc ${shellSingleQuote(c)}`;
    })
    .join("\n");

  // Trap reports the failed step explicitly ("solve, don't punt" — fail loud
  // with the exact line number rather than a generic shell exit). 30s timeout
  // matches typical exec defaults; lower if a step routinely runs longer.
  return `#!/usr/bin/env bash
# Validated workflow replay — generated from procedural memory.
# Run from workspace root. Exits non-zero on first failing step with a
# precise step pointer so callers can resume from the right place.
set -Eeuo pipefail

# Why 1: scripts should always print where they failed; "punt to operator"
# is the anti-pattern called out in Anthropic's skill authoring guide.
trap 'rc=$?; echo "[replay.sh] FAILED at line $LINENO (exit=$rc). Stop and report; do not improvise side effects." >&2; exit $rc' ERR

${body}

echo "[replay.sh] All replay steps completed."
`;
}
