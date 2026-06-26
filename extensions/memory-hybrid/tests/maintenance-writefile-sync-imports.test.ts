/**
 * Regression guard for #1963: maintenance paths must import writeFileSync from node:fs
 * so esbuild bundles do not emit bare ReferenceError at runtime.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

const MAINTENANCE_FS_WRITE_PATHS = [
  "services/cron-guard.ts",
  "services/maintenance-timestamp.ts",
  "cli/cmd-distill.ts",
  "cli/commands/manage/maintenance-step-runners.ts",
  "utils/atomic-write.ts",
];

describe("maintenance writeFileSync imports (#1963)", () => {
  for (const rel of MAINTENANCE_FS_WRITE_PATHS) {
    it(`${rel} imports writeFileSync from node:fs when used`, () => {
      const content = readFileSync(join(ROOT, rel), "utf-8");
      if (!content.includes("writeFileSync")) return;
      expect(content).toMatch(/from\s+["']node:fs["']/);
      expect(content).toMatch(/\bwriteFileSync\b/);
    });
  }

  it("maintenance modules load without ReferenceError", async () => {
    await import("../services/cron-guard.ts");
    await import("../services/maintenance-timestamp.ts");
    await import("../utils/atomic-write.ts");
    await import("../cli/commands/manage/maintenance-step-runners.ts");
  });
});
