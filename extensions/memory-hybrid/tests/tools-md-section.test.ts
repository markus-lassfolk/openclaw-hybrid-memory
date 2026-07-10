import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRulesUnderSection } from "../services/tools-md-section.js";

describe("tools-md-section", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tools-md-"));
  });

  afterEach(() => {
    try {
      if (tmpDir) rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("creates section and appends rules when file is empty", () => {
    const path = join(tmpDir, "TOOLS.md");
    writeFileSync(path, "", "utf-8");
    const { inserted, sectionExisted } = insertRulesUnderSection(path, "Self-correction rules", [
      "If CLI fails twice, fall back to cURL.",
    ]);
    expect(inserted).toBe(1);
    expect(sectionExisted).toBe(false);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("## Self-correction rules");
    expect(content).toContain("- If CLI fails twice, fall back to cURL.");
  });

  it("inserts under existing section and dedups", () => {
    const path = join(tmpDir, "TOOLS.md");
    writeFileSync(
      path,
      "# TOOLS\n\n## General\n- Use bash.\n\n## Self-correction rules\n- Existing rule.\n\n## Other\n- Rest.",
      "utf-8",
    );
    const { inserted, sectionExisted } = insertRulesUnderSection(path, "Self-correction rules", [
      "New rule here.",
      "Existing rule.", // duplicate
      "Another new.",
    ]);
    expect(inserted).toBe(2);
    expect(sectionExisted).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("- Existing rule.");
    expect(content).toContain("- New rule here.");
    expect(content).toContain("- Another new.");
    expect(content).toMatch(/## Other/);
  });

  it("inserts nothing when all rules are duplicates", () => {
    const path = join(tmpDir, "TOOLS.md");
    writeFileSync(path, "## Self-correction rules\n- Same rule.\n", "utf-8");
    const { inserted } = insertRulesUnderSection(path, "Self-correction rules", ["Same rule.", "same rule."]);
    expect(inserted).toBe(0);
  });

  it("keeps rule bullets as one unbroken list across repeated inserts, instead of a blank line before every new batch (#2067-followup)", () => {
    const path = join(tmpDir, "TOOLS.md");
    writeFileSync(
      path,
      "# TOOLS\n\n## Self-correction rules\n- First batch rule.\n\n## Other\n- Rest.",
      "utf-8",
    );
    insertRulesUnderSection(path, "Self-correction rules", ["Second batch rule."]);
    insertRulesUnderSection(path, "Self-correction rules", ["Third batch rule."]);

    const content = readFileSync(path, "utf-8");
    // The dead `before.trimEnd().endsWith("\n")` check always evaluated false, so every insert
    // unconditionally prepended a blank line before its new bullet(s) -- breaking what should be
    // one continuous bullet list under the section into visually-disconnected mini-lists that
    // grow more fragmented with every self-correction/cron cycle that appends rules.
    expect(content).toContain(
      "## Self-correction rules\n- First batch rule.\n- Second batch rule.\n- Third batch rule.\n\n## Other",
    );
  });
});
