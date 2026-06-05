import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSHOP_MAX_PENDING,
  enforceMaxPendingCap,
  inspectUnifiedProposal,
  listUnifiedProposals,
  listUndoablePersonaProposals,
  makeUnifiedKey,
  mergeWorkshopListItems,
  parseUnifiedKey,
  resolveWorkshopMaxPending,
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

  it("enforceMaxPendingCap blocks when pending reaches limit", () => {
    const stores = {
      proposalsDb: {
        list: (filters?: { status?: string }) =>
          filters?.status === "pending"
            ? [{ id: "p1", title: "x", status: "pending", confidence: 0.5, createdAt: 1, targetFile: "SOUL.md", observation: "", suggestedChange: "" }]
            : [],
      },
      crystallizationStore: null,
      toolProposalStore: null,
      factsDb: { getProceduresReadyForSkill: () => [] },
      cfg: { personaProposals: { enabled: true }, procedures: { enabled: false } },
    } as never;

    expect(enforceMaxPendingCap(stores, 0).ok).toBe(true);
    const blocked = enforceMaxPendingCap(stores, 1);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.pending).toBe(1);
    expect(DEFAULT_WORKSHOP_MAX_PENDING).toBe(50);
  });

  it("resolveWorkshopMaxPending honors personaProposals.workshopMaxPending", () => {
    expect(resolveWorkshopMaxPending({ personaProposals: { workshopMaxPending: 25 } } as never)).toBe(25);
    expect(resolveWorkshopMaxPending({ personaProposals: { workshopMaxPending: 0 } } as never)).toBe(0);
    expect(resolveWorkshopMaxPending(undefined)).toBe(50);
  });

  it("enforceMaxPendingCap treats 0 as unlimited", () => {
    const stores = {
      proposalsDb: {
        list: () => [{ id: "p1", status: "pending" }],
      },
      crystallizationStore: null,
      toolProposalStore: null,
      factsDb: { getProceduresReadyForSkill: () => [] },
      cfg: { personaProposals: { enabled: true }, procedures: { enabled: false } },
    } as never;
    expect(enforceMaxPendingCap(stores, 0).ok).toBe(true);
  });

  it("inspectUnifiedProposal loads persona proposals by direct id lookup", () => {
    const applied = {
      id: "abc",
      title: "Test",
      status: "applied",
      confidence: 0.9,
      createdAt: 100,
      targetFile: "SOUL.md",
      targetHash: null,
      observation: "obs",
      suggestedChange: "change",
      evidenceSessions: [],
    };
    const stores = {
      proposalsDb: { get: (id: string) => (id === "abc" ? applied : null), list: () => [] },
      crystallizationStore: null,
      toolProposalStore: null,
      factsDb: { getProceduresReadyForSkill: () => [] },
      cfg: { personaProposals: { enabled: true } },
    } as never;
    const item = inspectUnifiedProposal(stores, makeUnifiedKey("persona", "abc"));
    expect(item?.actions.undoSupported).toBe(false);
    expect(item?.status).toBe("applied");
    expect(item?.id).toBe("abc");
  });

  it("listUndoablePersonaProposals returns applied persona items", () => {
    const stores = {
      proposalsDb: {
        list: (filters?: { status?: string }) =>
          filters?.status === "applied"
            ? [{ id: "u1", title: "Undo me", status: "applied", confidence: 0.8, createdAt: 1, targetFile: "SOUL.md", observation: "", suggestedChange: "" }]
            : [],
      },
      crystallizationStore: null,
      toolProposalStore: null,
      factsDb: { getProceduresReadyForSkill: () => [] },
      cfg: { personaProposals: { enabled: true } },
    } as never;
    const items = listUndoablePersonaProposals(stores, 5);
    expect(items).toHaveLength(0);
  });

  it("listUndoablePersonaProposals includes applied persona with rollback metadata", () => {
    const stores = {
      proposalsDb: {
        list: (filters?: { status?: string }) =>
          filters?.status === "applied"
            ? [{ id: "u1", title: "Undo me", status: "applied", confidence: 0.8, createdAt: 1, targetFile: "SOUL.md", observation: "", suggestedChange: "" }]
            : [],
      },
      crystallizationStore: null,
      toolProposalStore: null,
      factsDb: { getProceduresReadyForSkill: () => [] },
      cfg: { personaProposals: { enabled: true } },
      resolvedSqlitePath: "/tmp/test-facts.db",
    } as never;
    // Without rollback file on disk, item is filtered out
    const items = listUndoablePersonaProposals(stores, 5);
    expect(items).toHaveLength(0);
  });

  it("persona undoSupported requires rollback metadata when resolvedSqlitePath is set", () => {
    const applied = {
      id: "abc",
      title: "Test",
      status: "applied" as const,
      confidence: 0.9,
      createdAt: 100,
      targetFile: "SOUL.md",
      targetHash: null,
      observation: "obs",
      suggestedChange: "change",
      evidenceSessions: [],
    };
    const stores = {
      proposalsDb: { get: (id: string) => (id === "abc" ? applied : null), list: () => [] },
      crystallizationStore: null,
      toolProposalStore: null,
      factsDb: { getProceduresReadyForSkill: () => [] },
      cfg: { personaProposals: { enabled: true } },
      resolvedSqlitePath: "/nonexistent/facts.db",
    } as never;
    const item = inspectUnifiedProposal(stores, makeUnifiedKey("persona", "abc"));
    expect(item?.actions.undoSupported).toBe(false);
  });

  it("mergeWorkshopListItems deduplicates and sorts by createdAt", () => {
    const pending = [{ unifiedKey: "persona:p1", createdAt: 10 } as never];
    const undoable = [
      { unifiedKey: "persona:p1", createdAt: 20 } as never,
      { unifiedKey: "persona:p2", createdAt: 30 } as never,
    ];
    const merged = mergeWorkshopListItems(pending, undoable, 10);
    expect(merged.map((p) => p.unifiedKey)).toEqual(["persona:p2", "persona:p1"]);
  });

  it("disables crystallization approve when workflowStore is unavailable", () => {
    const stores = {
      proposalsDb: null,
      crystallizationStore: {
        list: () => [
          {
            id: "c1",
            skillName: "test-skill",
            status: "drafted",
            confidence: 0.7,
            createdAt: "2026-01-01T00:00:00Z",
            skillContent: "# Skill",
          },
        ],
      },
      toolProposalStore: null,
      factsDb: { getProceduresReadyForSkill: () => [] },
      cfg: { personaProposals: { enabled: false }, procedures: { enabled: false } },
      workflowStore: null,
    } as never;
    const items = listUnifiedProposals(stores, { status: "pending" });
    expect(items).toHaveLength(1);
    expect(items[0]?.actions.approveSupported).toBe(false);
    expect(items[0]?.actions.rejectSupported).toBe(true);
  });

  it("enforceMaxPendingCap excludes virtual procedure-skill queue from cap", () => {
    const stores = {
      proposalsDb: {
        list: (filters?: { status?: string }) =>
          filters?.status === "pending"
            ? [{ id: "p1", title: "x", status: "pending", confidence: 0.5, createdAt: 1, targetFile: "SOUL.md", observation: "", suggestedChange: "" }]
            : [],
      },
      crystallizationStore: null,
      toolProposalStore: null,
      factsDb: {
        getProceduresReadyForSkill: () => [
          { id: "proc1", taskPattern: "Ready proc", successCount: 5, promotedToSkill: 0 },
        ],
      },
      cfg: { personaProposals: { enabled: true }, procedures: { enabled: true, validationThreshold: 3 } },
    } as never;
    const blocked = enforceMaxPendingCap(stores, 1);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.pending).toBe(1);
  });
});
