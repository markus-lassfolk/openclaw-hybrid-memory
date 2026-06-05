import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSHOP_MAX_PENDING,
  enforceMaxPendingCap,
  makeUnifiedKey,
  parseUnifiedKey,
} from "../services/unified-proposals.js";

describe("unified-proposals", () => {
  it("makeUnifiedKey and parseUnifiedKey round-trip", () => {
    const key = makeUnifiedKey("persona", "abc-123");
    expect(key).toBe("persona:abc-123");
    expect(parseUnifiedKey(key)).toEqual({ type: "persona", storeId: "abc-123" });
  });

  it("parseUnifiedKey rejects invalid keys", () => {
    expect(parseUnifiedKey("bad")).toBeNull();
    expect(parseUnifiedKey("unknown:id")).toBeNull();
  });

  it("enforceMaxPendingCap blocks at default limit", () => {
    const stores = {
      proposalsDb: null,
      crystallizationStore: null,
      toolProposalStore: null,
      factsDb: {
        search: () => [],
        getProceduresReadyForSkill: () => [],
      },
      cfg: {
        personaProposals: { enabled: false },
        procedures: { requireApprovalForPromote: false },
        crystallization: { enabled: false },
        selfExtension: { enabled: false },
      },
    } as never;

    const cap = enforceMaxPendingCap(stores, 0);
    expect(cap.ok).toBe(false);
    if (!cap.ok) {
      expect(cap.maxPending).toBe(0);
    }
    expect(DEFAULT_WORKSHOP_MAX_PENDING).toBe(50);
  });
});
