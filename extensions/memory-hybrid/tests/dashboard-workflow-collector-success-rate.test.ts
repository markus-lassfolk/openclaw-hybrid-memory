/**
 * Regression test (loop iteration 127) for routes/dashboard/collectors.ts's
 * `collectMemoryViewerWorkflows`:
 *
 * `WorkflowStore.getPatterns()` clusters traces by *similarity* (default threshold 0.8), and each
 * returned `WorkflowPattern.toolSequence` is only the first trace's sequence that started that
 * cluster (the "representative"), not every member's exact sequence. The collector looked up a
 * trace's success rate via exact `JSON.stringify` equality against that representative, so only
 * the one trace that happens to equal the representative sequence got the real aggregate rate --
 * every other member of the same cluster silently fell back to `successRate: 0`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import type { DashboardContext } from "../routes/dashboard/collectors.js";
import { collectMemoryViewerWorkflows } from "../routes/dashboard/collectors.js";

const { WorkflowStore } = _testing;

let tmpDir: string;
let store: InstanceType<typeof WorkflowStore>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "dashboard-workflow-collector-test-"));
  store = new WorkflowStore(join(tmpDir, "workflow-traces.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const REPRESENTATIVE_SEQ = ["read_file", "edit_file", "run_tests", "a", "b", "c", "d", "e", "f", "g"];
// One substitution at index 2 out of 10 tools -> similarity 0.9 (>= the 0.8 clustering threshold),
// so this still clusters with REPRESENTATIVE_SEQ but is never exactly equal to it.
const VARIANT_SEQ = ["read_file", "edit_file", "run_test", "a", "b", "c", "d", "e", "f", "g"];

describe("collectMemoryViewerWorkflows success rate lookup (loop iteration 127 regression)", () => {
  it("assigns the cluster's aggregate success rate to traces that only approximately match the representative", () => {
    store.record({ goal: "g1", toolSequence: REPRESENTATIVE_SEQ, outcome: "failure" });
    store.record({ goal: "g2", toolSequence: VARIANT_SEQ, outcome: "success" });
    store.record({ goal: "g3", toolSequence: VARIANT_SEQ, outcome: "success" });

    const ctx = { workflowStore: store } as unknown as DashboardContext;
    const workflows = collectMemoryViewerWorkflows(ctx);

    expect(workflows).toHaveLength(3);
    const expectedRate = 2 / 3; // 2 successes out of 3 traces in the cluster
    for (const w of workflows) {
      expect(w.successRate).toBeCloseTo(expectedRate, 5);
    }
  });

  it("still returns 0 for a trace whose sequence never clusters with anything", () => {
    store.record({ goal: "solo", toolSequence: ["totally_unrelated_tool"], outcome: "success" });

    const ctx = { workflowStore: store } as unknown as DashboardContext;
    const workflows = collectMemoryViewerWorkflows(ctx);

    expect(workflows).toHaveLength(1);
    // A cluster of one still reports its own (real) success rate, not a stale fallback.
    expect(workflows[0].successRate).toBe(1);
  });
});
