/**
 * Shared helpers for multi-incident LLM batch analysis (self-correction, reinforcement).
 */

const INCIDENT_INDEX_FIELD = "incidentIndex";

export type BatchCoverageFailureReason = "zero_parsed" | "under_coverage" | "over_coverage";

export type BatchCoverageResult =
  | { ok: true }
  | { ok: false; reason: BatchCoverageFailureReason; expected: number; parsed: number };

/** Serialize incidents for the analyze prompt with stable 0-based indices. */
export function serializeIncidentsForBatchPrompt<T extends Record<string, unknown>>(batch: T[]): string {
  return JSON.stringify(
    batch.map((incident, incidentIndex) => ({
      ...incident,
      [INCIDENT_INDEX_FIELD]: incidentIndex,
    })),
  );
}

/** Sum incident counts for all batches before `batchIndex` (stable on resume). */
export function globalIncidentOffsetForBatch(batches: { length: number }[], batchIndex: number): number {
  let offset = 0;
  for (let i = 0; i < batchIndex; i++) offset += batches[i]?.length ?? 0;
  return offset;
}

/** Resolve 0-based incident index from model output; falls back to array position when absent. */
export function resolveIncidentIndexInBatch(
  item: Record<string, unknown>,
  itemPosition: number,
  batchLength: number,
  globalOffset = 0,
): number {
  if (batchLength <= 0) return 0;

  const raw = item[INCIDENT_INDEX_FIELD] ?? item.incident_index ?? item._batchIndex;
  if (typeof raw === "number" && Number.isInteger(raw)) {
    if (raw >= 0 && raw < batchLength) return raw;
    if (raw >= 1 && raw <= batchLength) return raw - 1;
    if (globalOffset > 0 && raw >= globalOffset && raw < globalOffset + batchLength) {
      return raw - globalOffset;
    }
    return -1;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(parsed)) {
      if (parsed >= 0 && parsed < batchLength) return parsed;
      if (parsed >= 1 && parsed <= batchLength) return parsed - 1;
      if (globalOffset > 0 && parsed >= globalOffset && parsed < globalOffset + batchLength) {
        return parsed - globalOffset;
      }
      return -1;
    }
  }

  return Math.min(itemPosition, batchLength - 1);
}

export function checkBatchRemediationCoverage(batchLength: number, parsedCount: number): BatchCoverageResult {
  if (batchLength <= 0) return { ok: true };
  if (parsedCount === 0) return { ok: false, reason: "zero_parsed", expected: batchLength, parsed: 0 };
  if (parsedCount < batchLength) {
    return { ok: false, reason: "under_coverage", expected: batchLength, parsed: parsedCount };
  }
  if (parsedCount > batchLength) {
    return { ok: false, reason: "over_coverage", expected: batchLength, parsed: parsedCount };
  }
  return { ok: true };
}

export type OrderedBatchItems<T> = {
  items: T[];
  /** 0-based index in the batch for each item (same length as items). */
  batchIndices: number[];
};

/**
 * Place items into incident slots using incidentIndex.
 * Fails when any slot is missing, indices collide, or item count exceeds batch length.
 */
export function orderBatchItemsByIncidentIndex<T extends Record<string, unknown>>(
  batchLength: number,
  items: T[],
  logger?: { warn?: (msg: string) => void },
  globalOffset = 0,
): OrderedBatchItems<T> | null {
  if (batchLength === 0) return { items: [], batchIndices: [] };
  if (items.length === 0) return null;

  if (items.length > batchLength) {
    logger?.warn?.(
      `memory-hybrid: batch analysis too many items: expected=${batchLength} parsed=${items.length}`,
    );
    return null;
  }

  const slots: Array<T | null> = Array.from({ length: batchLength }, () => null);

  for (let position = 0; position < items.length; position++) {
    const item = items[position]!;
    const idx = resolveIncidentIndexInBatch(item, position, batchLength, globalOffset);
    if (idx < 0) {
      logger?.warn?.(
        `memory-hybrid: batch analysis out-of-range incidentIndex=${String(item[INCIDENT_INDEX_FIELD] ?? item.incident_index ?? item._batchIndex)}; rejecting batch`,
      );
      return null;
    }
    if (slots[idx] !== null) {
      logger?.warn?.(
        `memory-hybrid: batch analysis duplicate incidentIndex=${idx}; rejecting batch`,
      );
      return null;
    }
    slots[idx] = item;
  }

  const emptySlots = slots.map((slot, i) => (slot === null ? i : -1)).filter((i) => i >= 0);
  if (emptySlots.length > 0) return null;

  const ordered: T[] = [];
  const batchIndices: number[] = [];
  for (let i = 0; i < batchLength; i++) {
    ordered.push(slots[i] as T);
    batchIndices.push(i);
  }
  return { items: ordered, batchIndices };
}

/**
 * Merge split sub-batch results with incidentIndex re-based to parent batch coordinates.
 */
export function mergeSplitBatchItemsWithOffset<T extends Record<string, unknown>>(
  leftItems: T[],
  rightItems: T[],
  leftBatchSize: number,
  rightBatchSize = rightItems.length,
): T[] {
  const normalize = (batchItems: T[], baseOffset: number, subBatchSize: number) =>
    batchItems.map((item, position) => {
      const localIdx = resolveIncidentIndexInBatch(item, position, subBatchSize);
      return { ...item, [INCIDENT_INDEX_FIELD]: baseOffset + localIdx };
    });
  return [
    ...normalize(leftItems, 0, leftBatchSize),
    ...normalize(rightItems, leftBatchSize, rightBatchSize),
  ];
}

export function stripBatchMetadataFromItem<T extends Record<string, unknown>>(item: T): Omit<T, "incidentIndex" | "incident_index" | "_batchIndex"> {
  const { [INCIDENT_INDEX_FIELD]: _a, incident_index: _b, _batchIndex: _c, ...rest } = item;
  return rest as Omit<T, "incidentIndex" | "incident_index" | "_batchIndex">;
}

/** Append remediations, skipping duplicate global incidentIndex values (safe on batch resume). */
export function appendUniqueRemediationsByIncidentIndex<
  TTarget extends { incidentIndex?: number; remediationType?: string },
  TIncoming extends { incidentIndex?: number; remediationType?: string },
>(
  target: TTarget[],
  incoming: TIncoming[],
): number {
  const seen = new Set(
    target.map((item) => item.incidentIndex).filter((idx): idx is number => typeof idx === "number"),
  );
  let added = 0;
  for (const item of incoming) {
    const idx = item.incidentIndex;
    if (typeof idx === "number") {
      if (seen.has(idx)) {
        const existingIndex = target.findIndex((t) => t.incidentIndex === idx);
        const existing = existingIndex >= 0 ? target[existingIndex] : undefined;
        if (
          existing &&
          existing.remediationType === "NO_ACTION" &&
          item.remediationType !== "NO_ACTION"
        ) {
          target[existingIndex] = item as unknown as TTarget;
          added++;
        }
        continue;
      }
      seen.add(idx);
    }
    target.push(item as unknown as TTarget);
    added++;
  }
  return added;
}

export function attachOrderedItemsToIncidents<TIncident, TItem extends Record<string, unknown>>(
  batch: TIncident[],
  ordered: OrderedBatchItems<TItem>,
  globalIncidentOffset: number,
): Array<Omit<TItem, "incidentIndex" | "incident_index" | "_batchIndex"> & { incidentIndex: number; sourceIncident: TIncident }> {
  return ordered.items.map((item, i) => {
    const batchIdx = ordered.batchIndices[i] ?? i;
    return {
      ...stripBatchMetadataFromItem(item),
      incidentIndex: globalIncidentOffset + batchIdx,
      sourceIncident: batch[batchIdx],
    };
  });
}
