/**
 * Internal helpers for procedure triage (split from procedures.ts).
 */
import { createHash } from "node:crypto";

import type { ProcedureEntry } from "../../../types/memory.js";
import type { ProcedurePromotionBlockReason, ProcedureTriageRow, ProcedureTriageSummary } from "./types.js";

export const PROCEDURE_BLOCK_REASONS: ProcedurePromotionBlockReason[] = [
  "duplicate_skill",
  "low_recall",
  "missing_anchor",
  "awaiting_approval",
  "unknown",
];

export function summarizeProcedureTriage(rows: ProcedureTriageRow[]): ProcedureTriageSummary {
  const byReason = Object.fromEntries(PROCEDURE_BLOCK_REASONS.map((reason) => [reason, 0])) as Record<
    ProcedurePromotionBlockReason,
    number
  >;
  for (const row of rows) byReason[row.promotionBlockReason] = (byReason[row.promotionBlockReason] ?? 0) + 1;
  const top = Object.entries(byReason)
    .filter(([, count]) => count > 0)
    .sort(
      (a, b) =>
        b[1] - a[1] ||
        PROCEDURE_BLOCK_REASONS.indexOf(a[0] as ProcedurePromotionBlockReason) -
          PROCEDURE_BLOCK_REASONS.indexOf(b[0] as ProcedurePromotionBlockReason),
    )[0];
  return { total: rows.length, byReason, topReason: top ? (top[0] as ProcedurePromotionBlockReason) : null };
}

export function slugForProcedure(taskPattern: string): string {
  const base = taskPattern
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  const hash = createHash("sha1").update(taskPattern).digest("hex").slice(0, 8);
  return `${base || "procedure"}-${hash}`;
}

function hasRecipeAnchor(recipeJson: string | null | undefined): boolean {
  if (!recipeJson || recipeJson.trim() === "") return false;
  try {
    const parsed = JSON.parse(recipeJson) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    return parsed.some((step) => {
      if (step == null || typeof step !== "object") return false;
      const s = step as Record<string, unknown>;
      return typeof s.tool === "string" && s.tool.trim().length > 0;
    });
  } catch {
    return false;
  }
}

export function procedureBlockReason(
  row: ProcedureEntry,
  duplicateSlugs: Set<string>,
  validationThreshold: number,
): ProcedurePromotionBlockReason {
  if (row.skillPath != null && row.skillPath.trim() !== "") return "duplicate_skill";
  if (duplicateSlugs.has(slugForProcedure(row.taskPattern))) return "duplicate_skill";
  if (!hasRecipeAnchor(row.recipeJson)) return "missing_anchor";
  if (row.successCount < validationThreshold) return "low_recall";
  if (row.confidence < 0.5) return "low_recall";
  if (row.successCount >= validationThreshold && row.promotedToSkill !== 1) return "awaiting_approval";
  return "unknown";
}
