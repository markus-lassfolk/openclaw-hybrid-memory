/**
 * Pre-flight identity gap scoring for generate-proposals (no LLM).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry } from "../types/memory.js";

export const IDENTITY_GAP_FILES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;

export type IdentityGapResult = {
  score: number;
  bullets: string[];
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );
}

function overlapRatio(insightTokens: Set<string>, fileText: string): number {
  const fileTokens = tokenSet(fileText);
  if (insightTokens.size === 0) return 1;
  let hit = 0;
  for (const t of insightTokens) {
    if (fileTokens.has(t)) hit++;
  }
  return hit / insightTokens.size;
}

export function scoreIdentityGaps(insights: MemoryEntry[], workspaceRoot: string, topN = 12): IdentityGapResult {
  const bullets: string[] = [];
  const identityContents: Record<string, string> = {};
  for (const file of IDENTITY_GAP_FILES) {
    const path = join(workspaceRoot, file);
    identityContents[file] = existsSync(path) ? readFileSync(path, "utf-8") : "";
  }

  const candidates = insights
    .filter((f) => ["pattern", "rule", "meta"].includes(f.category) || f.tags?.includes("meta"))
    .slice(0, topN);

  if (candidates.length === 0) {
    return { score: 0, bullets: ["No pattern/rule/meta insights available for gap scoring."] };
  }

  let uncovered = 0;
  for (const insight of candidates) {
    const tokens = tokenSet(insight.text);
    let bestFile = IDENTITY_GAP_FILES[0];
    let bestOverlap = 0;
    for (const file of IDENTITY_GAP_FILES) {
      const ratio = overlapRatio(tokens, identityContents[file] ?? "");
      if (ratio > bestOverlap) {
        bestOverlap = ratio;
        bestFile = file;
      }
    }
    if (bestOverlap < 0.25) {
      uncovered++;
      const preview = insight.text.slice(0, 100).replace(/\s+/g, " ");
      bullets.push(`Uncovered in ${bestFile}: "${preview}" (overlap ${(bestOverlap * 100).toFixed(0)}%)`);
    }
  }

  const score = candidates.length > 0 ? uncovered / candidates.length : 0;
  if (bullets.length === 0) {
    bullets.push("Top insights appear partially reflected in identity files (low gap score).");
  }
  return { score, bullets };
}
