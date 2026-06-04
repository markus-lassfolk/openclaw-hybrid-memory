import { describe, expect, it, vi } from "vitest";
import {
  appendUniqueRemediationsByIncidentIndex,
  attachOrderedItemsToIncidents,
  globalIncidentOffsetForBatch,
  mergeSplitBatchItemsWithOffset,
  orderBatchItemsByIncidentIndex,
  resolveIncidentIndexInBatch,
  serializeIncidentsForBatchPrompt,
} from "../services/batch-incident-analysis.js";

describe("batch-incident-analysis", () => {
  it("globalIncidentOffsetForBatch sums prior batch sizes", () => {
    const batches = [[1, 2, 3], [4, 5], [6]];
    expect(globalIncidentOffsetForBatch(batches, 0)).toBe(0);
    expect(globalIncidentOffsetForBatch(batches, 1)).toBe(3);
    expect(globalIncidentOffsetForBatch(batches, 2)).toBe(5);
  });

  it("serializeIncidentsForBatchPrompt adds 0-based incidentIndex", () => {
    const json = serializeIncidentsForBatchPrompt([{ userMessage: "a", sessionFile: "s.jsonl" }]);
    expect(JSON.parse(json)[0].incidentIndex).toBe(0);
  });

  it("resolveIncidentIndexInBatch prefers explicit incidentIndex over position", () => {
    expect(resolveIncidentIndexInBatch({ incidentIndex: 2 }, 0, 4)).toBe(2);
    expect(resolveIncidentIndexInBatch({ incidentIndex: 4 }, 0, 4)).toBe(3);
    expect(resolveIncidentIndexInBatch({ remediationType: "X" }, 1, 4)).toBe(1);
  });

  it("orderBatchItemsByIncidentIndex reorders out-of-order items", () => {
    const ordered = orderBatchItemsByIncidentIndex(3, [
      { incidentIndex: 2, remediationType: "NO_ACTION" },
      { incidentIndex: 0, remediationType: "TOOLS_RULE" },
      { incidentIndex: 1, remediationType: "MEMORY_STORE" },
    ]);
    expect(ordered?.items.map((i) => i.incidentIndex)).toEqual([0, 1, 2]);
  });

  it("orderBatchItemsByIncidentIndex returns null when a slot is missing", () => {
    expect(
      orderBatchItemsByIncidentIndex(3, [
        { incidentIndex: 0, remediationType: "NO_ACTION" },
        { incidentIndex: 2, remediationType: "NO_ACTION" },
      ]),
    ).toBeNull();
  });

  it("orderBatchItemsByIncidentIndex returns null on duplicate incidentIndex", () => {
    expect(
      orderBatchItemsByIncidentIndex(4, [
        { incidentIndex: 0, remediationType: "NO_ACTION" },
        { incidentIndex: 0, remediationType: "TOOLS_RULE" },
        { incidentIndex: 1, remediationType: "NO_ACTION" },
        { incidentIndex: 2, remediationType: "NO_ACTION" },
      ]),
    ).toBeNull();
  });

  it("orderBatchItemsByIncidentIndex returns null when too many items are returned", () => {
    expect(
      orderBatchItemsByIncidentIndex(2, [
        { incidentIndex: 0, remediationType: "NO_ACTION" },
        { incidentIndex: 1, remediationType: "NO_ACTION" },
        { incidentIndex: 0, remediationType: "TOOLS_RULE" },
      ]),
    ).toBeNull();
  });

  it("mergeSplitBatchItemsWithOffset re-bases sub-batch indices to parent coordinates", () => {
    const merged = mergeSplitBatchItemsWithOffset(
      [
        { incidentIndex: 1, remediationType: "A" },
        { incidentIndex: 0, remediationType: "B" },
      ],
      [
        { incidentIndex: 1, remediationType: "C" },
        { incidentIndex: 0, remediationType: "D" },
      ],
      2,
    );
    expect(merged.map((i) => i.incidentIndex)).toEqual([1, 0, 3, 2]);
  });

  it("appendUniqueRemediationsByIncidentIndex upgrades NO_ACTION on resume retry", () => {
    const analysed: { incidentIndex: number; remediationType: string }[] = [
      { incidentIndex: 0, remediationType: "NO_ACTION" },
    ];
    const added = appendUniqueRemediationsByIncidentIndex(analysed, [
      { incidentIndex: 0, remediationType: "TOOLS_RULE" },
      { incidentIndex: 1, remediationType: "NO_ACTION" },
    ]);
    expect(added).toBe(2);
    expect(analysed.map((i) => i.incidentIndex)).toEqual([0, 1]);
    expect(analysed[0].remediationType).toBe("TOOLS_RULE");
    expect(analysed[1].remediationType).toBe("NO_ACTION");
  });

  it("resolveIncidentIndexInBatch rejects global indices outside batch", () => {
    expect(resolveIncidentIndexInBatch({ incidentIndex: 51 }, 0, 3)).toBe(-1);
    expect(resolveIncidentIndexInBatch({ incidentIndex: 12 }, 0, 3, 10)).toBe(2);
  });

  it("orderBatchItemsByIncidentIndex rejects out-of-range incidentIndex", () => {
    expect(
      orderBatchItemsByIncidentIndex(3, [{ incidentIndex: 99, remediationType: "NO_ACTION" }]),
    ).toBeNull();
  });

  it("attachOrderedItemsToIncidents applies global offset and strips metadata", () => {
    const batch = [
      { userMessage: "a", sessionFile: "a.jsonl" },
      { userMessage: "b", sessionFile: "b.jsonl" },
    ];
    const ordered = orderBatchItemsByIncidentIndex(2, [
      { incidentIndex: 1, remediationType: "NO_ACTION", category: "x", severity: "LOW" },
      { incidentIndex: 0, remediationType: "TOOLS_RULE", category: "y", severity: "LOW" },
    ]);
    expect(ordered).not.toBeNull();
    const attached = attachOrderedItemsToIncidents(batch, ordered!, 10);
    expect(attached[0].incidentIndex).toBe(10);
    expect(attached[1].incidentIndex).toBe(11);
    expect(attached[0].sourceIncident).toEqual(batch[0]);
    expect((attached[0] as Record<string, unknown>).incidentIndex).toBe(10);
    expect("incidentIndex" in (attached[0] as object)).toBe(true);
  });
});
