import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TOOLS_MD_MANAGED_BEGIN,
  TOOLS_MD_MANAGED_END,
  applyToolsMdRules,
  validateToolsMdRewrite,
} from "../services/tools-md-rewrite.js";

describe("tools-md-rewrite", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tools-md-rewrite-"));
  });

  afterEach(() => {
    try {
      if (tmpDir) rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("rejects rewrite that drops managed block", () => {
    const original = `# TOOLS\n\n${TOOLS_MD_MANAGED_BEGIN}\nbody\n${TOOLS_MD_MANAGED_END}\n`;
    const rewritten = "# TOOLS\n\n## Rules\n- New rule.\n";
    const result = validateToolsMdRewrite(original, rewritten, ["New rule."]);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("managed block"))).toBe(true);
  });

  it("falls back to section insert when rewrite validation fails", () => {
    const path = join(tmpDir, "TOOLS.md");
    writeFileSync(path, "# TOOLS\n", "utf-8");
    const result = applyToolsMdRules({
      toolsPath: path,
      sectionTitle: "Self-correction rules",
      newRules: ["Always verify before deploy."],
      autoRewrite: true,
      rewrittenContent: "# TOOLS\n",
    });
    expect(result.method).toBe("insert");
    expect(result.toolsApplied).toBe(1);
    expect(result.rewriteRejectedReasons?.length).toBeGreaterThan(0);
    const body = readFileSync(path, "utf-8");
    expect(body).toContain("Always verify before deploy.");
  });

  it("creates TOOLS.md via section insert when missing", () => {
    const path = join(tmpDir, "TOOLS.md");
    const result = applyToolsMdRules({
      toolsPath: path,
      sectionTitle: "Self-correction rules",
      newRules: ["Use curl fallback."],
      autoRewrite: false,
    });
    expect(result.toolsApplied).toBe(1);
    expect(readFileSync(path, "utf-8")).toContain("Use curl fallback.");
  });
});
