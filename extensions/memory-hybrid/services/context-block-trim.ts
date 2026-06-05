/**
 * Trim structured context blocks to a token budget (line-preserving, XML-tag aware).
 */

import { estimateTokens } from "../utils/text.js";

export function trimBlockToBudget(
  block: string,
  maxTokens: number,
): { text: string; sourceTokens: number; usedTokens: number } {
  const sourceTokens = block ? estimateTokens(block) : 0;
  if (!block || sourceTokens === 0 || maxTokens <= 0) {
    return { text: "", sourceTokens, usedTokens: 0 };
  }
  if (sourceTokens <= maxTokens) {
    return { text: block, sourceTokens, usedTokens: sourceTokens };
  }

  const trailingNewlines = block.match(/\n+$/)?.[0] ?? "";
  const core = trailingNewlines.length > 0 ? block.slice(0, -trailingNewlines.length) : block;
  const lines = core.split("\n");
  if (lines.length === 0) return { text: "", sourceTokens, usedTokens: 0 };

  const first = lines[0] ?? "";
  const last = lines[lines.length - 1] ?? "";
  const firstTagMatch = first.match(/^<([^>\s/]+)>$/);
  const lastTagMatch = last.match(/^<\/([^>\s]+)>$/);
  if (lines.length >= 3 && firstTagMatch && lastTagMatch && firstTagMatch[1] === lastTagMatch[1]) {
    const middle = lines.slice(1, -1);
    for (let keep = middle.length; keep >= 0; keep--) {
      const candidate = [first, ...middle.slice(0, keep), last].join("\n") + trailingNewlines;
      const candidateTokens = estimateTokens(candidate);
      if (candidateTokens <= maxTokens) {
        return { text: candidate, sourceTokens, usedTokens: candidateTokens };
      }
    }
    return { text: "", sourceTokens, usedTokens: 0 };
  }

  for (let keep = lines.length; keep >= 1; keep--) {
    const candidate = lines.slice(0, keep).join("\n") + trailingNewlines;
    const candidateTokens = estimateTokens(candidate);
    if (candidateTokens <= maxTokens) {
      return { text: candidate, sourceTokens, usedTokens: candidateTokens };
    }
  }
  return { text: "", sourceTokens, usedTokens: 0 };
}
