import { describe, expect, it } from "vitest";

import { type ClosureCandidate, evaluateStrictDuplicateClosureGuard } from "../services/duplicate-closure-guard.js";

function baseCandidate(overrides: Partial<ClosureCandidate> = {}): ClosureCandidate {
  return {
    candidateRef: "#1593",
    replacementRef: "#1600",
    sameIssueScope: true,
    replacementState: "merged",
    replacementBranchRecoverable: true,
    hasScopeCoverageNote: true,
    implementationClassCompatibility: true,
    hasFileOverlap: true,
    hasSemanticCoverageNote: false,
    hasEvidenceCommentText: true,
    ...overrides,
  };
}

describe("evaluateStrictDuplicateClosureGuard", () => {
  it("marks same-title different issue scope unsafe (#1560 vs #1561 style)", () => {
    const result = evaluateStrictDuplicateClosureGuard([
      baseCandidate({
        candidateRef: "#1561",
        replacementRef: "#1560",
        sameIssueScope: false,
      }),
    ]);

    expect(result.decision).toBe("needs-reconciliation");
    expect(result.assessments[0]?.reasons).toContain("different_issue_scope");
  });

  it("marks zero file overlap unsafe without semantic evidence", () => {
    const result = evaluateStrictDuplicateClosureGuard([
      baseCandidate({
        hasFileOverlap: false,
        hasSemanticCoverageNote: false,
      }),
    ]);

    expect(result.decision).toBe("needs-reconciliation");
    expect(result.assessments[0]?.reasons).toContain("no_overlap_without_semantic_coverage");
  });

  it("marks docs/workflow-only replacement unsafe for implementation candidate", () => {
    const result = evaluateStrictDuplicateClosureGuard([
      baseCandidate({
        implementationClassCompatibility: false,
      }),
    ]);

    expect(result.decision).toBe("needs-reconciliation");
    expect(result.assessments[0]?.reasons).toContain("implementation_class_incompatible");
  });

  it("marks deleted/missing replacement branch unsafe", () => {
    const result = evaluateStrictDuplicateClosureGuard([
      baseCandidate({
        replacementBranchRecoverable: false,
      }),
    ]);

    expect(result.decision).toBe("needs-reconciliation");
    expect(result.assessments[0]?.reasons).toContain("replacement_branch_not_recoverable");
  });

  it("marks missing evidence comment unsafe", () => {
    const result = evaluateStrictDuplicateClosureGuard([
      baseCandidate({
        hasEvidenceCommentText: false,
      }),
    ]);

    expect(result.decision).toBe("needs-reconciliation");
    expect(result.assessments[0]?.reasons).toContain("missing_individual_evidence_comment");
  });

  it("marks valid same-issue same-files merged replacement with full proof as safe", () => {
    const result = evaluateStrictDuplicateClosureGuard([
      baseCandidate({
        candidateRef: "#1609",
        replacementRef: "#1610",
        sameIssueScope: true,
        replacementState: "merged",
        replacementBranchRecoverable: true,
        hasScopeCoverageNote: true,
        implementationClassCompatibility: true,
        hasFileOverlap: true,
        hasSemanticCoverageNote: false,
        hasEvidenceCommentText: true,
      }),
    ]);

    expect(result.decision).toBe("safe");
    expect(result.assessments[0]?.reasons).toHaveLength(0);
  });
});
