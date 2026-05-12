import { expect } from "vitest";
import type { PendingDecision, PendingDecisionContext, PendingItem } from "../../services/pending-autopilot/index.js";
import { computePendingInputHash, sanitizePendingDecision } from "../../services/pending-autopilot/index.js";

export interface PendingAutopilotEquivalenceFixture<TItem extends PendingItem = PendingItem> {
  item: TItem;
  policy: string;
  policyVersion: string;
}

export type PendingAutopilotExecutionPath<TItem extends PendingItem = PendingItem> = (
  item: TItem,
  context: PendingDecisionContext,
) => Promise<PendingDecision> | PendingDecision;

/**
 * Parent/child equivalence primitive for child issues #1326-#1330.
 * Callers must pass two distinct execution paths: standalone child execution and
 * parent orchestration execution. The harness compares normalized decisions for
 * the same fixture, policy, and input hash.
 */
export async function expectStandaloneAndParentDecisionsEquivalent<TItem extends PendingItem>(input: {
  standalone: PendingAutopilotExecutionPath<TItem>;
  parent: PendingAutopilotExecutionPath<TItem>;
  fixtures: PendingAutopilotEquivalenceFixture<TItem>[];
}): Promise<void> {
  const standalone: PendingDecision[] = [];
  const parentRun: PendingDecision[] = [];
  for (const fixture of input.fixtures) {
    const inputHash = computePendingInputHash({
      queue: fixture.item.queue,
      id: fixture.item.id,
      payload: fixture.item.payload,
      policy: fixture.policy,
      policyVersion: fixture.policyVersion,
    });
    expect(fixture.item.inputHash).toBe(inputHash);
    const baseContext: PendingDecisionContext = {
      runId: "standalone",
      jobId: "job-1",
      mode: "dry-run",
      policy: fixture.policy,
      policyVersion: fixture.policyVersion,
      inputHash: fixture.item.inputHash,
      actor: { type: "test", id: "equivalence-harness" },
    };
    const parentContext: PendingDecisionContext = { ...baseContext, runId: "parent-run" };
    standalone.push(sanitizePendingDecision(await input.standalone(fixture.item, baseContext)));
    parentRun.push(sanitizePendingDecision(await input.parent(fixture.item, parentContext)));
  }
  expect(normalize(standalone)).toEqual(normalize(parentRun));
}

function normalize(decisions: PendingDecision[]): Array<Omit<PendingDecision, "runId" | "createdAt">> {
  return decisions
    .map(({ runId: _runId, createdAt: _createdAt, ...decision }) => ({
      ...decision,
      audit: decision.audit ? { ...decision.audit, runId: "normalized-run" } : decision.audit,
    }))
    .sort((a, b) => {
      const ak = `${a.queue}:${a.itemId}:${a.policy}:${a.inputHash}`;
      const bk = `${b.queue}:${b.itemId}:${b.policy}:${b.inputHash}`;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
}
