import type {
  DuplicateClosureDecision,
  DuplicateClosureAssessment,
  DuplicateClosureGuardProof,
} from "../types/issue-types.js";

export type ClosureDecision = DuplicateClosureDecision;
export type ClosureAssessment = DuplicateClosureAssessment;
export type ClosureGuardResult = DuplicateClosureGuardProof;

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

  const decision: ClosureDecision =
    assessments.length > 0 && assessments.every((item) => item.decision === "safe") ? "safe" : "needs-reconciliation";

  return {
    decision,
    assessments,
  };
}
