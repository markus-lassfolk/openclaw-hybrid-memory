/**
 * Generated skill size limits.
 *
 * OpenClaw's workspace skill loader skips SKILL.md files above 256 KB. Keep
 * this hard cap aligned with that external loader contract and enforce it
 * before generated procedure skills are written.
 */

/** OpenClaw loader hard cap for a single SKILL.md file. */
export const MAX_SKILL_FILE_BYTES = 256_000;

/** Safer generator target that leaves room for future loader metadata changes. */
export const MAX_SKILL_FILE_BYTES_SAFE = 200_000;

/** Initial cap for generated procedure recipe sidecars. */
export const MAX_RECIPE_FILE_BYTES = 256_000;

/** Initial cap for optional generated sidecars. */
export const MAX_SKILL_SIDECAR_BYTES = 128_000;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
