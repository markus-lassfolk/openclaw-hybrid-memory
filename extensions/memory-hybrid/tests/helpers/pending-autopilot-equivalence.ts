import { expect } from "vitest";
import type {
  PendingDecision,
  PendingDecisionContext,
  PendingItem,
  PendingQueueAdapter,
} from "../../services/pending-autopilot/index.js";
import { computePendingInputHash, sanitizePendingDecision } from "../../services/pending-autopilot/index.js";

export interface PendingAutopilotEquivalenceFixture<TItem extends PendingItem = PendingItem> {
  item: TItem;
  policyVersion: string;
}

/**
 * Parent/child equivalence primitive for child issues #1326-#1330.
 * It proves a queue adapter emits the same decisions when invoked standalone and
 * when invoked through a parent-style run context for the same fixture and input hash.
 */
export async function expectStandaloneAndParentDecisionsEquivalent<TItem extends PendingItem>(
  adapter: PendingQueueAdapter<TItem>,
  fixtures: PendingAutopilotEquivalenceFixture<TItem>[],
): Promise<void> {
  const standalone: PendingDecision[] = [];
  const parentRun: PendingDecision[] = [];
  for (const fixture of fixtures) {
    const inputHash = computePendingInputHash({
      queue: fixture.item.queue,
      id: fixture.item.id,
      payload: fixture.item.payload,
      policyVersion: fixture.policyVersion,
    });
    const baseContext: PendingDecisionContext = {
      runId: "standalone",
      mode: "dry-run",
      policyVersion: fixture.policyVersion,
      inputHash,
    };
    const parentContext: PendingDecisionContext = { ...baseContext, runId: "parent-run" };
    standalone.push(sanitizePendingDecision(await adapter.decide(fixture.item, baseContext)));
    parentRun.push(sanitizePendingDecision(await adapter.decide(fixture.item, parentContext)));
  }
  expect(normalize(standalone)).toEqual(normalize(parentRun));
}

function normalize(decisions: PendingDecision[]): Array<Omit<PendingDecision, "runId" | "createdAt">> {
  return decisions
    .map(({ runId: _runId, createdAt: _createdAt, ...decision }) => decision)
    .sort((a, b) => `${a.queue}:${a.itemId}`.localeCompare(`${b.queue}:${b.itemId}`));
}
