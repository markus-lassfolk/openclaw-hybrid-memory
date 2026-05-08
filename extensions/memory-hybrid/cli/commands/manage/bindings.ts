// biome-ignore lint/style/useImportType: mergeResults kept as value import so typeof mergeResults resolves at the type level without confusion
import { mergeResults } from "../../../services/merge-results.js";
import type { ManageContext } from "../../context.js";

/**
 * Shared flattened context for manage command modules (Issue #955).
 * Includes `merge` as an alias for `mergeResults` and `ctx` for sparse `ctx.*` access.
 */
export type ManageBindings = ManageContext & {
  ctx: ManageContext;
  merge: typeof mergeResults;
  BACKFILL_DECAY_MARKER: string;
};

export function buildManageBindings(ctx: ManageContext): ManageBindings {
  return {
    ...ctx,
    ctx,
    merge: ctx.mergeResults,
    BACKFILL_DECAY_MARKER: ".backfill-decay-done",
  };
}
