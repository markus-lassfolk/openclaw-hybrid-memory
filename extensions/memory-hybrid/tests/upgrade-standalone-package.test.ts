import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  STANDALONE_UPGRADE_CMD,
  STANDALONE_UPGRADE_PACKAGE,
  formatManualUpgradeFallback,
} from "../cli/install/upgrade-config-preflight.js";

// #2021: `hybrid-mem upgrade` and every "manual upgrade" fallback used to shell out to
// `openclaw-hybrid-mem-upgrade`, a package that was never published to npm (404). The
// blessed standalone installer is `openclaw-hybrid-memory-install`, which lives in-repo
// under packages/ and is published by the release workflow.
describe("standalone upgrade package (#2021)", () => {
  it("targets the published openclaw-hybrid-memory-install package, not the unpublished one", () => {
    expect(STANDALONE_UPGRADE_PACKAGE).toBe("openclaw-hybrid-memory-install");
    expect(STANDALONE_UPGRADE_CMD).toBe("npx -y openclaw-hybrid-memory-install");
    expect(STANDALONE_UPGRADE_CMD).not.toContain("openclaw-hybrid-mem-upgrade");
  });

  it("manual-upgrade fallback message references the published package", () => {
    const msg = formatManualUpgradeFallback("2026.7.33");
    expect(msg).toContain("npx -y openclaw-hybrid-memory-install 2026.7.33");
    expect(msg).not.toContain("openclaw-hybrid-mem-upgrade");
  });

  it("the referenced standalone installer package actually exists in the repo", () => {
    const pkgDir = join(import.meta.dirname, "..", "..", "..", "packages", STANDALONE_UPGRADE_PACKAGE);
    expect(existsSync(join(pkgDir, "package.json"))).toBe(true);
    expect(existsSync(join(pkgDir, "install.js"))).toBe(true);
  });
});
