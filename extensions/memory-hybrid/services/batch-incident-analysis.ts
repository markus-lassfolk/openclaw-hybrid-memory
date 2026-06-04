/**
 * Shared helpers for multi-incident LLM batch analysis (self-correction, reinforcement).
 */

const INCIDENT_INDEX_FIELD = "incidentIndex";

export type BatchCoverageFailureReason = "zero_parsed" | "under_coverage";

export type BatchCoverageResult =
  | { ok: true }
  | { ok: false; reason: BatchCoverageFailureReason; expected: number; parsed: number };

/** Serialize incidents for the analyze prompt with stable 0-based indices. */
/** Sum incident counts for all batches before `batchIndex` (stable on resume). */
export function globalIncidentOffsetForBatch(batches: { length: number }[], batchIndex: number): number {
  let offset = 0;
  for (let i = 0; i < batchIndex; i++) offset += batches[i]?.length ?? 0;
  return offset;
}

export function serializeIncidentsForBatchPrompt<T extends Record<string, unknown>>(batch: T[]): string {
  return JSON.stringify(
    batch.map((incident, incidentIndex) => ({
      ...incident,
      [INCIDENT_INDEX_FIELD]: incidentIndex,
    })),
  );
}

/** Resolve 0-based incident index from model output; falls back to array position. */
export function resolveIncidentIndexInBatch(
  item: Record<string, unknown>,
  itemPosition: number,
  batchLength: number,
): number {
  if (batchLength <= 0) return 0;

  const raw = item[INCIDENT_INDEX_FIELD] ?? item.incident_index ?? item._batchIndex;
  if (typeof raw === "number" && Number.isInteger(raw)) {
    if (raw >= 0 && raw < batchLength) return raw;
    if (raw >= 1 && raw <= batchLength) return raw - 1;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(parsed)) {
      if (parsed >= 0 && parsed < batchLength) return parsed;
      if (parsed >= 1 && parsed <= batchLength) return parsed - 1;
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
  return { ok: true };
}

export type OrderedBatchItems<T> = {
  items: T[];
  /** 0-based index in the batch for each item (same length as items). */
  batchIndices: number[];
};

/**
 * Place items into incident slots using incidentIndex; drop extras; fail if any slot stays empty.
 */
export function orderBatchItemsByIncidentIndex<T extends Record<string, unknown>>(
  batchLength: number,
  items: T[],
  logger?: { warn?: (msg: string) => void },
): OrderedBatchItems<T> | null {
  if (batchLength === 0) return { items: [], batchIndices: [] };
  if (items.length === 0) return null;

  const slots: Array<T | null> = Array.from({ length: batchLength }, () => null);
  const overflow: T[] = [];

  items.forEach((item, position) => {
    const idx = resolveIncidentIndexInBatch(item, position, batchLength);
    if (slots[idx] === null) {
      slots[idx] = item;
    } else {
      overflow.push(item);
    }
  });

  for (const item of overflow) {
    const emptySlot = slots.findIndex((slot) => slot === null);
    if (emptySlot < 0) break;
    logger?.warn?.(
      `memory-hybrid: batch analysis duplicate incidentIndex; assigning overflow item to slot ${emptySlot}`,
    );
    slots[emptySlot] = item;
  }

  if (items.length > batchLength) {
    logger?.warn?.(
      `memory-hybrid: batch analysis dropping ${items.length - batchLength} extra item(s) beyond incident count`,
    );
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

export function stripBatchMetadataFromItem<T extends Record<string, unknown>>(item: T): Omit<T, "incidentIndex" | "incident_index" | "_batchIndex"> {
  const { [INCIDENT_INDEX_FIELD]: _a, incident_index: _b, _batchIndex: _c, ...rest } = item;
  return rest as Omit<T, "incidentIndex" | "incident_index" | "_batchIndex">;
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
