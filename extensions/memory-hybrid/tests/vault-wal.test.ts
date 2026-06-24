/**
 * Vault WAL path helpers (#1917).
 */

import { describe, expect, it } from "vitest";
import { resolveVaultWalPath } from "../config/vaults.js";

describe("resolveVaultWalPath (#1917)", () => {
  it("derives sibling .wal from sqlite path", () => {
    expect(resolveVaultWalPath("/home/user/.openclaw/work/project.db")).toBe("/home/user/.openclaw/work/project.wal");
  });
});
