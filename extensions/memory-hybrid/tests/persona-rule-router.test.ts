import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { assessPersonaProposalRouting, assessPersonaProposalRoutingSync } from "../cli/proposals.js";
import * as errorReporter from "../services/error-reporter.js";
import {
  classifyAuthorityBucket,
  findCrossFileContentMatch,
  personaRuleRoutingMetrics,
  resetPersonaRuleRoutingMetrics,
  routePersonaProposal,
  shouldBlockProposalCreation,
} from "../services/persona-rule-router.js";
import { DEFAULT_PERSONA_RULE_ROUTING } from "../services/persona-rule-router.js";

const LIVE_GITHUB_RULE =
  "File one focused GitHub issue per distinct problem with cloud-readable evidence; avoid omnibus tickets.";

const REGRESSION_PROPOSAL = {
  id: "de5ac67f-2bd0-4c56-b589-fe74f2aac639",
  targetFile: "SOUL.md",
  title: "GitHub issue discipline",
  observation: "Repeated omnibus tickets slow triage.",
  suggestedChange: LIVE_GITHUB_RULE,
  confidence: 0.75,
};

let tmpDir: string;
let factsDb: FactsDB;

beforeEach(() => {
  resetPersonaRuleRoutingMetrics();
  tmpDir = mkdtempSync(join(tmpdir(), "persona-rule-router-"));
  writeFileSync(join(tmpDir, "SOUL.md"), "# SOUL\nValues and tone.\n", "utf-8");
  writeFileSync(
    join(tmpDir, "AGENTS.md"),
    "# AGENTS\n## Issue Stewardship Phase Gate\nPrefer focused issues.\n",
    "utf-8",
  );
  writeFileSync(join(tmpDir, "USER.md"), "# USER\nPreferences.\n", "utf-8");
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function unit(vec: number[]): number[] {
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return mag === 0 ? vec : vec.map((v) => v / mag);
}

function makeEmbedder(vectors: Record<string, number[]>): (text: string) => Promise<number[]> {
  return async (text: string) => {
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    for (const [needle, vector] of Object.entries(vectors)) {
      if (normalized.includes(needle.toLowerCase())) return unit(vector);
    }
    return unit([0, 0, 1]);
  };
}

describe("routePersonaProposal", () => {
  it("routes GitHub issue workflow rules to AGENTS.md instead of SOUL.md", async () => {
    const assessment = await routePersonaProposal({
      targetFile: "SOUL.md",
      title: REGRESSION_PROPOSAL.title,
      observation: REGRESSION_PROPOSAL.observation,
      suggestedChange: REGRESSION_PROPOSAL.suggestedChange,
      confidence: REGRESSION_PROPOSAL.confidence,
      evidenceSessions: ["session-1"],
      workspaceRoot: tmpDir,
      allowedFiles: ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md"],
      routing: DEFAULT_PERSONA_RULE_ROUTING,
    });

    expect(assessment.recommendedTargetFile).toBe("AGENTS.md");
    expect(assessment.routingRationale).toMatch(/operational|GitHub|issue|workflow/i);
    expect(assessment.routingSuggestion?.recommendedTargetFile).toBe("AGENTS.md");
    expect(assessment.routingSuggestion?.callerTargetFile).toBe("SOUL.md");
  });

  it("preserves AGENTS.md routing suggestion when AGENTS.md is not in allowedFiles", async () => {
    const assessment = await routePersonaProposal({
      targetFile: "SOUL.md",
      title: REGRESSION_PROPOSAL.title,
      observation: REGRESSION_PROPOSAL.observation,
      suggestedChange: REGRESSION_PROPOSAL.suggestedChange,
      confidence: REGRESSION_PROPOSAL.confidence,
      evidenceSessions: ["session-1"],
      workspaceRoot: tmpDir,
      allowedFiles: ["SOUL.md", "IDENTITY.md", "USER.md"],
      routing: DEFAULT_PERSONA_RULE_ROUTING,
    });

    expect(assessment.recommendedTargetFile).toBe("AGENTS.md");
    expect(assessment.routingSuggestion?.recommendedTargetFile).toBe("AGENTS.md");
    expect(assessment.routingRationale).toMatch(/allowedFiles/i);
  });

  it("rejects semantic duplicate rule facts at or above dedupe threshold", async () => {
    const duplicateText = "Always file one focused GitHub issue per distinct problem.";
    factsDb.store({
      text: duplicateText,
      category: "rule",
      entity: "workflow",
      key: "github-issues",
      source: "reflection",
      importance: 0.8,
      value: null,
      tags: ["reflection", "rule"],
    });

    const embedText = makeEmbedder({
      "focused github issue": [1, 0, 0],
      "file one focused github issue per distinct problem": [1, 0, 0],
    });

    const assessment = await routePersonaProposal({
      targetFile: "SOUL.md",
      title: "Focused issues",
      observation: "Observed pattern",
      suggestedChange: "Append: File one focused GitHub issue per distinct problem with evidence.",
      confidence: 0.9,
      evidenceSessions: ["s1", "s2"],
      workspaceRoot: tmpDir,
      allowedFiles: ["SOUL.md", "AGENTS.md"],
      routing: DEFAULT_PERSONA_RULE_ROUTING,
      factsDb,
      embedText,
    });

    expect(assessment.blockReason).toBe("duplicate-rule");
    expect(assessment.blockCandidate?.source).toBe("memory-fact");
    expect(shouldBlockProposalCreation(assessment, "advisory")).toBe(true);
    expect(personaRuleRoutingMetrics.dedupHits).toBeGreaterThan(0);
  });

  it("logs (instead of silently swallowing) an embedding provider failure during routing (#45)", async () => {
    const captureSpy = vi.spyOn(errorReporter, "capturePluginError").mockImplementation(() => undefined);
    try {
      const failingEmbedText = async () => {
        throw new Error("embedding provider unavailable");
      };

      // Should not throw — cachedEmbed's failure degrades routing to text-pattern heuristics
      // rather than crashing the caller.
      const assessment = await routePersonaProposal({
        targetFile: "SOUL.md",
        title: REGRESSION_PROPOSAL.title,
        observation: REGRESSION_PROPOSAL.observation,
        suggestedChange: REGRESSION_PROPOSAL.suggestedChange,
        confidence: REGRESSION_PROPOSAL.confidence,
        evidenceSessions: ["session-1"],
        workspaceRoot: tmpDir,
        allowedFiles: ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md"],
        routing: DEFAULT_PERSONA_RULE_ROUTING,
        factsDb,
        embedText: failingEmbedText,
      });

      expect(assessment).toBeDefined();
      expect(captureSpy).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ subsystem: "persona-rule-router", operation: "cachedEmbed" }),
      );
    } finally {
      captureSpy.mockRestore();
    }
  });

  it("logs (instead of silently swallowing) a rule-facts DB read failure during routing (#45)", async () => {
    const captureSpy = vi.spyOn(errorReporter, "capturePluginError").mockImplementation(() => undefined);
    const listSpy = vi.spyOn(factsDb, "listFactsByCategory").mockImplementation(() => {
      throw new Error("sqlite disk I/O error");
    });
    try {
      // listRuleFacts is only reached once a query embedding vector is successfully produced,
      // so embedText must succeed here (unlike the cachedEmbed-failure test above).
      const embedText = makeEmbedder({ "github issue": [1, 0, 0] });

      // Should not throw — listRuleFacts's failure degrades to "no rule facts" rather than
      // crashing the caller.
      const assessment = await routePersonaProposal({
        targetFile: "SOUL.md",
        title: REGRESSION_PROPOSAL.title,
        observation: REGRESSION_PROPOSAL.observation,
        suggestedChange: REGRESSION_PROPOSAL.suggestedChange,
        confidence: REGRESSION_PROPOSAL.confidence,
        evidenceSessions: ["session-1"],
        workspaceRoot: tmpDir,
        allowedFiles: ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md"],
        routing: DEFAULT_PERSONA_RULE_ROUTING,
        factsDb,
        embedText,
      });

      expect(assessment).toBeDefined();
      expect(captureSpy).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ subsystem: "persona-rule-router", operation: "listRuleFacts" }),
      );
    } finally {
      listSpy.mockRestore();
      captureSpy.mockRestore();
    }
  });

  it("flags cross-file already-in-file matches against AGENTS.md when targeting USER.md", () => {
    const paragraph = "Dispatch all GitHub issue workflow through the Issue Stewardship Phase Gate.";
    writeFileSync(join(tmpDir, "AGENTS.md"), `# AGENTS\n${paragraph}\n`, "utf-8");

    const sync = assessPersonaProposalRoutingSync({
      targetFile: "USER.md",
      title: "Issue workflow",
      observation: "Observed",
      suggestedChange: paragraph,
      confidence: 0.9,
      evidenceSessions: ["s1"],
      workspaceRoot: tmpDir,
      allowedFiles: ["USER.md", "AGENTS.md"],
    });

    expect(sync.blockReason).toBe("already-in-file");
    expect(sync.blockCandidate?.location).toBe("AGENTS.md");
    expect(shouldBlockProposalCreation(sync, "advisory")).toBe(true);
  });

  it("marks contradictory rules with applyAllowed false and evidence excerpts", async () => {
    factsDb.store({
      text: "Always bundle related issues to reduce triage overhead.",
      category: "rule",
      entity: "workflow",
      key: "bundle-issues",
      source: "reflection",
      importance: 0.8,
      value: null,
      tags: ["reflection", "rule"],
    });

    const embedText = makeEmbedder({
      "never create omnibus": [1, 0, 0],
      "always bundle related issues": [0.7, 0.714, 0],
    });

    const assessment = await routePersonaProposal({
      targetFile: "AGENTS.md",
      title: "Issue bundling",
      observation: "Conflict spotted",
      suggestedChange: "Never create omnibus issues; always file one focused ticket.",
      confidence: 0.85,
      evidenceSessions: ["s1"],
      workspaceRoot: tmpDir,
      allowedFiles: ["AGENTS.md"],
      routing: DEFAULT_PERSONA_RULE_ROUTING,
      factsDb,
      embedText,
      adjudicateContradiction: async () => ({
        decision: "manual_review",
        reason: "Opposing issue bundling guidance",
      }),
    });

    expect(assessment.contradiction).toBe(true);
    expect(assessment.applyAllowed).toBe(false);
    expect(assessment.contradictionCandidates.length).toBeGreaterThan(0);
    expect(assessment.evidence.some((e) => e.type === "memory-fact")).toBe(true);
    expect(personaRuleRoutingMetrics.contradictionHits).toBeGreaterThan(0);
  });

  it("degrades to manual review when contradiction adjudication fails", async () => {
    factsDb.store({
      text: "Always bundle related issues to reduce triage overhead.",
      category: "rule",
      entity: "workflow",
      key: "bundle-issues",
      source: "reflection",
      importance: 0.8,
      value: null,
    });

    const embedText = makeEmbedder({
      "never create omnibus": [1, 0, 0],
      "always bundle related issues": [0.7, 0.714, 0],
    });

    const assessment = await routePersonaProposal({
      targetFile: "AGENTS.md",
      title: "Issue bundling",
      observation: "Conflict spotted",
      suggestedChange: "Never create omnibus issues.",
      confidence: 0.85,
      evidenceSessions: ["s1"],
      workspaceRoot: tmpDir,
      allowedFiles: ["AGENTS.md"],
      routing: DEFAULT_PERSONA_RULE_ROUTING,
      factsDb,
      embedText,
      adjudicateContradiction: async () => {
        throw new Error("timeout");
      },
    });

    expect(assessment.humanReviewRequired).toBe(true);
    expect(assessment.applyAllowed).toBe(false);
    expect(assessment.evidence.some((e) => e.type === "contradiction-degraded")).toBe(true);
    expect(personaRuleRoutingMetrics.contradictionDegraded).toBeGreaterThan(0);
  });

  it("routes recurring multi-step procedures to skill_workshop", async () => {
    const assessment = await routePersonaProposal({
      targetFile: "AGENTS.md",
      title: "Weekly release playbook",
      observation: "Repeats every sprint",
      suggestedChange:
        "Reusable workflow procedure:\n1. Run tests\n2. Tag release\n3. Publish notes\n4. Notify channel",
      confidence: 0.9,
      evidenceSessions: ["s1", "s2", "s3"],
      workspaceRoot: tmpDir,
      allowedFiles: ["AGENTS.md"],
      routing: DEFAULT_PERSONA_RULE_ROUTING,
    });

    expect(assessment.recommendedTargetFile).toBe("skill_workshop");
    expect(assessment.humanReviewRequired).toBe(true);
    expect(assessment.routingSuggestion?.recommendedTargetFile).toBe("skill_workshop");
  });

  it("regression fixture de5ac67f surfaces routing suggestion and cross-file awareness", async () => {
    writeFileSync(
      join(tmpDir, "AGENTS.md"),
      `# AGENTS\n${LIVE_GITHUB_RULE}\n`,
      "utf-8",
    );

    const assessment = await routePersonaProposal({
      targetFile: REGRESSION_PROPOSAL.targetFile,
      title: REGRESSION_PROPOSAL.title,
      observation: REGRESSION_PROPOSAL.observation,
      suggestedChange: REGRESSION_PROPOSAL.suggestedChange,
      confidence: REGRESSION_PROPOSAL.confidence,
      evidenceSessions: ["session-a"],
      workspaceRoot: tmpDir,
      allowedFiles: ["SOUL.md", "USER.md", "AGENTS.md"],
      routing: DEFAULT_PERSONA_RULE_ROUTING,
    });

    expect(assessment.routingSuggestion?.recommendedTargetFile).toBe("AGENTS.md");
    expect(assessment.blockReason === "already-in-file" || assessment.dedupScore >= 1).toBe(true);
    expect(assessment.overallDisposition).not.toBe("propose");
  });

  it("increments routing suggestion telemetry counters", async () => {
    await routePersonaProposal({
      targetFile: "SOUL.md",
      title: REGRESSION_PROPOSAL.title,
      observation: REGRESSION_PROPOSAL.observation,
      suggestedChange: REGRESSION_PROPOSAL.suggestedChange,
      confidence: 0.8,
      evidenceSessions: ["s1"],
      workspaceRoot: tmpDir,
      allowedFiles: ["SOUL.md", "AGENTS.md"],
      routing: DEFAULT_PERSONA_RULE_ROUTING,
    });
    expect(personaRuleRoutingMetrics.routingSuggestions).toBeGreaterThan(0);
  });

  it("does not block proposal creation when routing is disabled", async () => {
    writeFileSync(join(tmpDir, "AGENTS.md"), `# AGENTS\n${LIVE_GITHUB_RULE}\n`, "utf-8");
    const assessment = await assessPersonaProposalRouting({
      targetFile: "USER.md",
      title: "Dup",
      observation: "Observed",
      suggestedChange: LIVE_GITHUB_RULE,
      confidence: 0.9,
      evidenceSessions: ["s1"],
      workspaceRoot: tmpDir,
      allowedFiles: ["USER.md"],
      personaRuleRouting: { enabled: false },
    });
    expect(assessment.blockReason).toBeUndefined();
    expect(shouldBlockProposalCreation(assessment, "advisory")).toBe(false);
  });
});

describe("classifyAuthorityBucket", () => {
  it("classifies operational GitHub language into AGENTS.md bucket", () => {
    const result = classifyAuthorityBucket(LIVE_GITHUB_RULE);
    expect(result.bucket).toBe("AGENTS.md");
  });
});

describe("findCrossFileContentMatch", () => {
  it("finds exact paragraph matches in other authority files", () => {
    const snippet = "Only file focused GitHub issues with cloud-readable evidence.";
    writeFileSync(join(tmpDir, "AGENTS.md"), `# AGENTS\n${snippet}\n`, "utf-8");
    const match = findCrossFileContentMatch({
      suggestedChange: snippet,
      workspaceRoot: tmpDir,
      excludeFile: "USER.md",
    });
    expect(match?.file).toBe("AGENTS.md");
  });
});
