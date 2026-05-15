/**
 * Re-scan of installed crystallization skills (#1392) — validates on-disk SKILL.md
 * and quarantines rows that fail generated-skill validation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import type { WorkflowPattern } from "../backends/workflow-store.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { CrystallizationProposer } from "../services/crystallization-proposer.js";

const CFG_BASE: CrystallizationConfig = {
  enabled: true,
  minUsageCount: 2,
  minSuccessRate: 0.5,
  autoApprove: false,
  outputDir: "",
  maxCrystallized: 50,
  pruneUnusedDays: 30,
  evidenceCountBucketSize: 5,
};

describe("CrystallizationProposer.rescanInstalledSkills", () => {
  let tmpDir: string | null = null;
  let cStore: CrystallizationStore | null = null;
  let wfStore: WorkflowStore | null = null;

  afterEach(() => {
    wfStore?.close();
    cStore?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    wfStore = null;
    cStore = null;
    tmpDir = null;
  });

  it("quarantines installed proposal when on-disk SKILL.md fails validation", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "skills-rescan-"));
    const outputDir = join(tmpDir, "skills");
    const skillDir = join(outputDir, "bad-skill");
    mkdirSync(skillDir, { recursive: true });
    const outputPath = join(skillDir, "SKILL.md");
    writeFileSync(
      outputPath,
      `---
name: bad-skill
description: Bad skill with private contact
---

# bad-skill

## When to Use
Use it.

## Instructions
Contact admin@realdomain.com
`,
      "utf-8",
    );

    const store = new CrystallizationStore(join(tmpDir, "cp.db"));
    const workflows = new WorkflowStore(join(tmpDir, "wf.db"));
    cStore = store;
    wfStore = workflows;

    const pattern: WorkflowPattern = {
      toolSequence: ["read", "write"],
      totalCount: 5,
      successCount: 5,
      failureCount: 0,
      successRate: 1,
      avgDurationMs: 100,
      exampleGoals: ["Deploy production application release with full verification steps"],
    };

    const p = store.create({
      patternId: "pid1",
      evidenceHash: "ev1",
      skillName: "bad-skill",
      skillContent: "# placeholder",
      patternSnapshot: JSON.stringify(pattern),
      status: "validated",
    });
    expect(store.approve(p.id)).not.toBeNull();
    store.install(p.id, outputPath);

    const cfg: CrystallizationConfig = { ...CFG_BASE, outputDir };
    const proposer = new CrystallizationProposer(workflows, store, cfg);
    const result = proposer.rescanInstalledSkills();

    expect(result.scanned).toBe(1);
    expect(result.quarantined).toBe(1);
    const row = store.getById(p.id);
    expect(row?.status).toBe("quarantined");
    expect(row?.rejectionReason ?? "").toMatch(/^stale validation:/);
  });

  it("validates installed skills against their stored output root after cfg.outputDir changes", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "skills-rescan-root-"));
    const originalOutputDir = join(tmpDir, "original-skills");
    const currentOutputDir = join(tmpDir, "current-skills");
    const skillDir = join(originalOutputDir, "legacy-safe-skill");
    mkdirSync(skillDir, { recursive: true });
    const outputPath = join(skillDir, "SKILL.md");
    writeFileSync(
      outputPath,
      `# Legacy Crystallized Workflow

> Auto-crystallized from workflow pattern on 2020-01-01.

Bounded narrative body without YAML.
`,
      "utf-8",
    );

    const store = new CrystallizationStore(join(tmpDir, "cp.db"));
    const workflows = new WorkflowStore(join(tmpDir, "wf.db"));
    cStore = store;
    wfStore = workflows;

    const pattern: WorkflowPattern = {
      toolSequence: ["read", "write"],
      totalCount: 5,
      successCount: 5,
      failureCount: 0,
      successRate: 1,
      avgDurationMs: 100,
      exampleGoals: ["Deploy production application release with full verification steps"],
    };

    const p = store.create({
      patternId: "pid-root",
      evidenceHash: "ev-root",
      skillName: "legacy-safe-skill",
      skillContent: "# placeholder",
      patternSnapshot: JSON.stringify(pattern),
      status: "validated",
    });
    expect(store.approve(p.id)).not.toBeNull();
    store.install(p.id, outputPath);

    const cfg: CrystallizationConfig = { ...CFG_BASE, outputDir: currentOutputDir };
    const proposer = new CrystallizationProposer(workflows, store, cfg);
    const result = proposer.rescanInstalledSkills();

    expect(result.errors).toEqual([]);
    expect(result.scanned).toBe(1);
    expect(result.quarantined).toBe(0);
    expect(store.getById(p.id)?.status).toBe("installed");
  });
});
