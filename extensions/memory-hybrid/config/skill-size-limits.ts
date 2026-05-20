/**
 * Shared size limits for generated skills (issues #1537, #1540, #1542).
 * Aligns with OpenClaw workspace skill loader default (256 KB).
 */

/** OpenClaw `DEFAULT_MAX_SKILL_FILE_BYTES` — hard loader ceiling. */
export const MAX_SKILL_FILE_BYTES = 256_000;

/** Conservative write-time target for generated `SKILL.md`. */
export const MAX_SKILL_FILE_BYTES_SAFE = 200_000;

/** Bounded `recipe.json` sidecar cap (UTF-8 bytes). */
export const MAX_RECIPE_JSON_BYTES = 64_000;

/** Max recipe steps retained in sidecar after summarization. */
export const MAX_RECIPE_STEPS_IN_SIDECAR = 50;

/** Max workflow lines in `SKILL.md` body. */
export const MAX_WORKFLOW_STEPS_IN_SKILL = 25;

/** Per-step summary length in workflow lines. */
export const MAX_STEP_SUMMARY_CHARS = 240;

/** Optional cap for total generated skill directory (UTF-8 bytes). */
export const MAX_SKILL_DIR_BYTES = 512_000;

/** Max `references/workflow.md` sidecar (UTF-8 bytes). */
export const MAX_REFERENCE_WORKFLOW_BYTES = 96_000;

/** Skill Creator description field limit. */
export const MAX_SKILL_DESCRIPTION_CHARS = 1024;

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
