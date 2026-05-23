export type ClosureDecision = "safe" | "needs-reconciliation";

export type ImplementationClass = "implementation" | "docs" | "workflow" | "mixed" | "unknown";

export interface ClosureCandidate {
  candidateRef: string;
  replacementRef?: string | null;
  sameIssueScope: boolean;
  replacementState: "open" | "merged" | "closed-unmerged" | "missing";
  replacementBranchRecoverable: boolean;
  hasScopeCoverageNote: boolean;
  implementationClassCompatibility: boolean;
  hasFileOverlap: boolean;
  hasSemanticCoverageNote: boolean;
  hasEvidenceCommentText: boolean;
}

export interface ClosureAssessment {
  candidateRef: string;
  replacementRef?: string | null;
  decision: ClosureDecision;
  reasons: string[];
}

export interface ClosureGuardResult {
  decision: ClosureDecision;
  assessments: ClosureAssessment[];
}

export function evaluateStrictDuplicateClosureGuard(candidates: ClosureCandidate[]): ClosureGuardResult {
  const assessments = candidates.map((candidate) => {
    const reasons: string[] = [];

    if (!candidate.sameIssueScope) {
      reasons.push("different_issue_scope");
    }
    if (!candidate.replacementRef) {
      reasons.push("missing_explicit_replacement");
    }
    if (!(candidate.replacementState === "open" || candidate.replacementState === "merged")) {
      reasons.push("replacement_not_open_or_merged");
    }
    if (!candidate.replacementBranchRecoverable) {
      reasons.push("replacement_branch_not_recoverable");
    }
    if (!candidate.hasScopeCoverageNote) {
      reasons.push("missing_scope_coverage_note");
    }
    if (!candidate.implementationClassCompatibility) {
      reasons.push("implementation_class_incompatible");
    }
    if (!candidate.hasFileOverlap && !candidate.hasSemanticCoverageNote) {
      reasons.push("no_overlap_without_semantic_coverage");
    }
    if (!candidate.hasEvidenceCommentText) {
      reasons.push("missing_individual_evidence_comment");
    }

    return {
      candidateRef: candidate.candidateRef,
      replacementRef: candidate.replacementRef,
      decision: reasons.length === 0 ? "safe" : "needs-reconciliation",
      reasons,
    } satisfies ClosureAssessment;
  });

  const decision: ClosureDecision = assessments.every((item) => item.decision === "safe")
    ? "safe"
    : "needs-reconciliation";

  return {
    decision,
    assessments,
  };
}
