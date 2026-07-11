/**
 * Regression test (#2067-followup) for services/per-folder-context.ts's
 * regeneratePerFolderContext():
 *
 * The SQL query backing CONTEXT.md generation had no scope filter at all, so a user/agent/
 * session-scoped decision or preference fact was written verbatim into memory/projects/<path>/
 * CONTEXT.md -- a file readable by any other agent/session with folder access. The sibling
 * export services (wiki-workspace-export.ts, public-artifacts-provider.ts) both apply
 * globalOnlyScopeFilter() before writing facts to a file for exactly this reason; this function
 * now does too.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { regeneratePerFolderContext } from "../services/per-folder-context.js";

let tmpDir: string;
let factsDb: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "per-folder-context-scope-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("per-folder-context scope leak (#2067-followup)", () => {
  it("does not write a scoped (non-global) decision fact into a shared CONTEXT.md file", () => {
    factsDb.store({
      text: "Decision: rotate the /srv/app/secrets credentials before Friday",
      category: "decision",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "agent",
      scopeTarget: "tenantA",
    });

    const memoryDir = join(tmpDir, "memory");
    const result = regeneratePerFolderContext(factsDb, memoryDir, { minFactsPerPath: 1 });

    expect(result.pathsWritten).toBe(0);
  });

  it("still writes a global-scope decision fact into CONTEXT.md", () => {
    factsDb.store({
      text: "Decision: use pnpm workspaces under /srv/app/packages",
      category: "decision",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "global",
    });

    const memoryDir = join(tmpDir, "memory");
    const result = regeneratePerFolderContext(factsDb, memoryDir, { minFactsPerPath: 1 });

    expect(result.pathsWritten).toBe(1);
    const outFile = join(memoryDir, "projects", "srv-app-packages", "CONTEXT.md");
    const content = readFileSync(outFile, "utf-8");
    expect(content).toContain("pnpm workspaces");
  });
});
