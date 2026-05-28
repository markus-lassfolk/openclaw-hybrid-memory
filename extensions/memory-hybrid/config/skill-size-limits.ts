/**
 * Generated skill size limits.
 *
 * OpenClaw's workspace skill loader skips SKILL.md files above 256 KB. Keep
 * this hard cap aligned with that external loader contract and enforce it
 * before generated procedure skills are written.
 */

/** OpenClaw loader hard cap for a single SKILL.md file. */
export const MAX_SKILL_FILE_BYTES = 256_000;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
