import { describe, expect, it } from "vitest";
import { clusterProcedureItems, buildClusterDeferMap } from "../services/procedure-cluster.js";
import {
  isLowConcreteness,
  isProcedureTooObvious,
  measureConcreteness,
} from "../services/procedure-selection-metrics.js";
import { toGerundSkillName, validateSkillName } from "../services/skill-name-validator.js";
import { buildPushySkillDescription } from "../services/skill-description-builder.js";
import { synthesizeTriggerEvalSet } from "../services/skill-eval-synthesizer.js";
import { maybeBundleReplayScript } from "../services/skill-script-bundler.js";
import { buildSkillExamplesSection } from "../services/skill-examples-builder.js";
import { addTableOfContentsIfLong } from "../services/skill-reference-sidecar.js";
import { buildActionableWorkflow } from "../services/procedure-skill-workflow.js";
import { MAX_SKILL_DESCRIPTION_CHARS } from "../config/skill-size-limits.js";

describe("skill-name-validator", () => {
  it("gerundizes check-* slugs", () => {
    expect(toGerundSkillName("check-moltbook-notifications")).toMatch(/^checking-/);
  });

  it("rejects reserved words and invalid chars", () => {
    expect(validateSkillName("anthropic-helper").join(" ")).toMatch(/reserved|anthropic/i);
    expect(validateSkillName("Bad_Name").join(" ")).toMatch(/lowercase|hyphens/i);
  });
});

describe("skill-description-builder", () => {
  it("builds pushy description under 1024 chars", () => {
    const desc = buildPushySkillDescription({
      taskPattern: "Check Moltbook notifications for new replies",
      keyword: "moltbook",
      recipe: [{ tool: "cron", summary: "list jobs" }],
    });
    expect(desc.length).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION_CHARS);
    expect(desc.toLowerCase()).toContain("use this skill");
  });
});

describe("skill-eval-synthesizer", () => {
  it("emits 8+8 trigger eval queries", () => {
    const { shouldTrigger, shouldNotTrigger, triggerEvalJson } = synthesizeTriggerEvalSet({
      skillName: "checking-notifications",
      taskPattern: "Check notifications",
      keyword: "notifications",
    });
    expect(shouldTrigger.length).toBe(8);
    expect(shouldNotTrigger.length).toBe(8);
    const parsed = JSON.parse(triggerEvalJson) as { should_trigger_queries: unknown[] };
    expect(parsed.should_trigger_queries.length).toBe(16);
  });
});

describe("procedure-cluster", () => {
  it("clusters similar task patterns", () => {
    const items = [
      {
        procedure: { id: "a", taskPattern: "check moltbook notifications daily", successCount: 3, confidence: 0.9 },
        payload: { skillSlug: "check-a" },
      },
      {
        procedure: { id: "b", taskPattern: "check moltbook notifications feed", successCount: 1, confidence: 0.8 },
        payload: { skillSlug: "check-b" },
      },
    ];
    const clusters = clusterProcedureItems(items, 0.6);
    expect(clusters.length).toBe(1);
    expect(clusters[0].representative.procedure.id).toBe("a");
    expect(clusters[0].relatedProcedureIds).toEqual(["b"]);
    const defer = buildClusterDeferMap(clusters);
    expect(defer.get("b")?.representativeId).toBe("a");
  });
});

describe("procedure-selection-metrics", () => {
  it("defers obvious single-read recipes", () => {
    expect(isProcedureTooObvious([{ tool: "read", summary: "read file" }])).toBe(true);
  });

  it("measures concreteness for rich tasks", () => {
    const m = measureConcreteness("deploy doris cluster upgrade", [
      { tool: "exec", summary: "kubectl apply" },
      { tool: "read", summary: "verify pods" },
    ]);
    expect(m.score).toBeGreaterThan(0.3);
    expect(isLowConcreteness("do it", [])).toBe(true);
  });
});

describe("skill-script-bundler", () => {
  it("writes replay.sh for exec recipes", () => {
    const script = maybeBundleReplayScript([
      { tool: "exec", args: { command: "npm test" } },
      { tool: "read", summary: "verify" },
    ]);
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("npm test");
    expect(script).not.toMatch(/\\\\/);
  });

  it("skips read-only-only recipes", () => {
    expect(
      maybeBundleReplayScript([{ tool: "read", summary: "x" }, { tool: "memory_recall", summary: "y" }]),
    ).toBeNull();
  });
});

describe("procedure-skill-workflow v2", () => {
  it("adds checklist for long workflows", () => {
    const recipe = Array.from({ length: 5 }, (_, i) => ({
      tool: "read",
      summary: `inspect component ${i} state`,
    }));
    const wf = buildActionableWorkflow(recipe, "inspect system health", "low");
    expect(wf).toContain("Workflow progress");
  });

  it("uses exact commands for high risk", () => {
    const wf = buildActionableWorkflow(
      [{ tool: "exec", args: { command: "rm -rf /tmp/safe" } }],
      "cleanup temp",
      "high",
    );
    expect(wf).toContain("Do not modify");
  });
});

describe("skill-reference-sidecar", () => {
  it("adds TOC for long markdown", () => {
    const long = `# Title\n\n${Array.from({ length: 120 }, (_, i) => `## Section ${i}\n\nbody\n`).join("\n")}`;
    expect(addTableOfContentsIfLong(long)).toContain("Table of contents");
  });
});

describe("skill-examples-builder", () => {
  it("renders concrete input/output examples", () => {
    const section = buildSkillExamplesSection({
      taskPattern: "Check notifications",
      nearMiss: "send notifications",
      recipe: [{ tool: "read", summary: "verify inbox count" }],
    });
    expect(section).toContain("**Example 1");
    expect(section).toContain("Input:");
    expect(section).toContain("Output:");
  });
});
