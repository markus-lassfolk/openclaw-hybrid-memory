import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
});
