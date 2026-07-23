/**
 * Dream compose candidate mappers (#2170 / #2175).
 */
import { describe, expect, it } from "vitest";
import {
  consolidateProposalsToCandidates,
  contradictionProposalsToCandidates,
  distillProposalsToCandidates,
  pinContradictionResolves,
  reflectProposalsToCandidates,
  selfCorrectionProposalsToCandidates,
} from "../services/dream-compose-candidates.js";

describe("dream-compose-candidates (#2170/#2175)", () => {
  it("maps distill proposals to add candidates", () => {
    const candidates = distillProposalsToCandidates({
      dreamRunId: "dream-1",
      sessionIds: ["s1"],
      proposals: [{ text: "User prefers dark mode in the editor UI", category: "preference" }],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.op).toBe("add");
    expect(candidates[0]?.payload.text).toContain("dark mode");
    expect(candidates[0]?.preHash).toBeUndefined();
  });

  it("maps consolidate merges with OCC preHash on deletes", () => {
    const candidates = consolidateProposalsToCandidates({
      dreamRunId: "dream-1",
      sessionIds: ["s1"],
      proposals: [
        {
          sourceFactIds: ["a", "b"],
          mergedText: "Merged operational preference about deploy targets",
          category: "preference",
          sourcePreHashes: { a: "hash-a", b: "hash-b" },
        },
      ],
    });
    expect(candidates.some((c) => c.op === "merge")).toBe(true);
    const deletes = candidates.filter((c) => c.op === "delete");
    expect(deletes).toHaveLength(2);
    expect(deletes.every((c) => typeof c.preHash === "string" && c.preHash.length > 0)).toBe(true);
  });

  it("maps contradiction resolves with preHash", () => {
    const candidates = contradictionProposalsToCandidates({
      dreamRunId: "dream-1",
      sessionIds: ["s1"],
      proposals: [
        {
          contradictionId: "c1",
          factIdNew: "n1",
          factIdOld: "o1",
          preHash: "occ-old",
          provenanceSessionIds: ["s1"],
          scope: "session",
          scopeTarget: "s1",
        },
      ],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.op).toBe("delete");
    expect(candidates[0]?.targetFactId).toBe("o1");
    expect(candidates[0]?.preHash).toBe("occ-old");
  });

  it("pinContradictionResolves skips superseded or missing OCC", () => {
    const pinned = pinContradictionResolves(
      [
        { contradictionId: "c1", factIdNew: "n1", factIdOld: "live" },
        { contradictionId: "c2", factIdNew: "n2", factIdOld: "gone" },
        { contradictionId: "c3", factIdNew: "n3", factIdOld: "superseded" },
        { contradictionId: "c4", factIdNew: "n4", factIdOld: "no-occ" },
      ],
      {
        getById: (id) => {
          if (id === "live") return { supersededAt: null };
          if (id === "superseded") return { supersededAt: 1 };
          if (id === "no-occ") return { supersededAt: null };
          return null;
        },
        getOccToken: (id) => (id === "live" ? "occ-live" : null),
      },
    );
    expect(pinned).toEqual([
      {
        contradictionId: "c1",
        factIdNew: "n1",
        factIdOld: "live",
        preHash: "occ-live",
        provenanceSessionIds: [],
        scope: null,
        scopeTarget: null,
      },
    ]);
  });

  it("maps reflect patterns to boundary write scope (not hardcoded global)", () => {
    const candidates = reflectProposalsToCandidates({
      dreamRunId: "dream-1",
      sessionIds: ["s1"],
      writeScope: "session",
      writeScopeTarget: "s1",
      proposals: [{ text: "When debugging, confirm reproduction before changing config" }],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.payload.category).toBe("pattern");
    expect(candidates[0]?.payload.scope).toBe("session");
    expect(candidates[0]?.payload.scopeTarget).toBe("s1");
  });

  it("maps self-correction MEMORY_STORE previews to add candidates", () => {
    const candidates = selfCorrectionProposalsToCandidates({
      dreamRunId: "dream-1",
      sessionIds: ["s1"],
      proposals: [{ text: "Prefer --json for maintenance CLIs", category: "technical", key: "cli-json" }],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.op).toBe("add");
    expect(candidates[0]?.payload.source).toBe("dream-self-correction");
    expect(candidates[0]?.payload.scope).toBe("session");
  });
});
