import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { ActiveTaskEntry } from "../services/active-task.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import {
  loadTaskLedgerFromFacts,
  reconcileActiveTaskLiveState,
  syncActiveTaskEntryToFacts,
} from "../services/task-ledger-facts.js";

const vectorDb = {
  hasDuplicate: async () => true,
  store: async () => {},
} as unknown as VectorDB;

const embeddings = {
  modelName: "test-model",
  embed: async () => new Float32Array([0.1, 0.2, 0.3]),
} as unknown as EmbeddingProvider;

const ghScript = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const logPath = process.env.MOCK_GH_CALL_LOG;
if (logPath) appendFileSync(logPath, JSON.stringify(args) + "\\n");
const table = JSON.parse(process.env.MOCK_GH_TABLE || "{}");
const repoIdx = args.indexOf("--repo");
const repo = repoIdx >= 0 ? args[repoIdx + 1] : "";
const number = args[2] || "";
const key = args[0] + ":" + repo + "#" + number;
const payload = table[key];
if (!payload) {
  process.stderr.write("mock gh: missing response for " + key + "\\n");
  process.exit(1);
}
if (typeof payload === "string") process.stdout.write(payload);
else process.stdout.write(JSON.stringify(payload));
`;

function baseTask(label: string, description: string): ActiveTaskEntry {
  const now = "2026-05-24T00:00:00.000Z";
  return {
    label,
    description,
    status: "In progress",
    started: now,
    updated: now,
  };
}

async function addTask(db: FactsDB, task: ActiveTaskEntry): Promise<void> {
  await syncActiveTaskEntryToFacts(db, vectorDb, embeddings, task);
}

async function readGhCalls(logPath: string): Promise<string[][]> {
  const raw = await readFile(logPath, "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

describe.sequential("task-ledger live-state reconciliation", () => {
  let ghBinDir = "";
  let ghCallLogPath = "";
  let oldPath: string | undefined;
  let oldGhToken: string | undefined;
  let oldMockTable: string | undefined;
  let oldCallLog: string | undefined;

  beforeEach(async () => {
    ghBinDir = await mkdtemp(join(tmpdir(), "hm-live-state-gh-"));
    ghCallLogPath = join(ghBinDir, "gh-calls.log");
    const ghPath = join(ghBinDir, "gh");
    await writeFile(ghPath, ghScript, "utf-8");
    await chmod(ghPath, 0o755);

    oldPath = process.env.PATH;
    oldGhToken = process.env.GH_TOKEN;
    oldMockTable = process.env.MOCK_GH_TABLE;
    oldCallLog = process.env.MOCK_GH_CALL_LOG;

    process.env.PATH = `${ghBinDir}:${oldPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    process.env.MOCK_GH_CALL_LOG = ghCallLogPath;
    process.env.MOCK_GH_TABLE = "{}";
  });

  afterEach(async () => {
    process.env.PATH = oldPath;
    if (oldGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldGhToken;
    if (oldMockTable === undefined) delete process.env.MOCK_GH_TABLE;
    else process.env.MOCK_GH_TABLE = oldMockTable;
    if (oldCallLog === undefined) delete process.env.MOCK_GH_CALL_LOG;
    else process.env.MOCK_GH_CALL_LOG = oldCallLog;
    await rm(ghBinDir, { recursive: true, force: true });
  });

  it("parses bare refs as issues and verbose refs by explicit kind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hm-live-state-ledger-"));
    const db = new FactsDB(join(dir, "facts.db"));
    try {
      await addTask(db, baseTask("issue-open", "Track acme/widgets#101"));
      await addTask(db, baseTask("pr-merged", "Land acme/widgets pull request #102"));
      await addTask(db, baseTask("issue-closed", "Follow up acme/widgets issue #103"));

      process.env.MOCK_GH_TABLE = JSON.stringify({
        "issue:acme/widgets#101": { state: "OPEN" },
        "pr:acme/widgets#102": { state: "MERGED", mergedAt: "2026-05-01T10:00:00Z", closedAt: "2026-05-01T10:00:00Z" },
        "issue:acme/widgets#103": { state: "CLOSED" },
      });

      const result = await reconcileActiveTaskLiveState(db, vectorDb, embeddings, { maxRequests: 10 });
      expect(result.checkedCount).toBe(3);
      expect(result.updatedCount).toBe(2);

      const calls = await readGhCalls(ghCallLogPath);
      expect(calls.some((args) => args[0] === "issue" && args[1] === "view" && args[2] === "101")).toBe(true);
      expect(calls.some((args) => args[0] === "pr" && args[1] === "view" && args[2] === "101")).toBe(false);
      expect(calls.some((args) => args[0] === "pr" && args[1] === "view" && args[2] === "102")).toBe(true);
      expect(calls.some((args) => args[0] === "issue" && args[1] === "view" && args[2] === "103")).toBe(true);

      const { active, completed } = loadTaskLedgerFromFacts(db);
      const activeLabels = new Set(active.map((t) => t.label));
      const doneLabels = new Set(completed.map((t) => t.label));

      expect(activeLabels.has("issue-open")).toBe(true);
      expect(doneLabels.has("pr-merged")).toBe(true);
      expect(doneLabels.has("issue-closed")).toBe(true);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("updates all tasks that share the same terminal ref and keeps issue/pr refs separate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hm-live-state-shared-"));
    const db = new FactsDB(join(dir, "facts.db"));
    try {
      await addTask(db, baseTask("same-number-issue", "Audit acme/shared#200"));
      await addTask(db, baseTask("same-number-pr", "Merge acme/shared pull request #200"));
      await addTask(db, baseTask("shared-pr-a", "Ship acme/shared pr #300"));
      await addTask(db, baseTask("shared-pr-b", "Backport acme/shared pull request #300"));

      process.env.MOCK_GH_TABLE = JSON.stringify({
        "issue:acme/shared#200": { state: "OPEN" },
        "pr:acme/shared#200": { state: "MERGED", mergedAt: "2026-05-02T11:00:00Z", closedAt: "2026-05-02T11:00:00Z" },
        "pr:acme/shared#300": { state: "CLOSED", mergedAt: null, closedAt: "2026-05-03T12:00:00Z" },
      });

      const result = await reconcileActiveTaskLiveState(db, vectorDb, embeddings, { maxRequests: 10 });
      expect(result.checkedCount).toBe(3);
      expect(result.updatedCount).toBe(3);

      const calls = await readGhCalls(ghCallLogPath);
      expect(calls.filter((args) => args[0] === "pr" && args[1] === "view" && args[2] === "300")).toHaveLength(1);
      expect(calls.filter((args) => args[0] === "issue" && args[1] === "view" && args[2] === "200")).toHaveLength(1);
      expect(calls.filter((args) => args[0] === "pr" && args[1] === "view" && args[2] === "200")).toHaveLength(1);

      const { active, completed } = loadTaskLedgerFromFacts(db);
      const activeLabels = new Set(active.map((t) => t.label));
      const doneLabels = new Set(completed.map((t) => t.label));

      expect(activeLabels.has("same-number-issue")).toBe(true);
      expect(doneLabels.has("same-number-pr")).toBe(true);
      expect(doneLabels.has("shared-pr-a")).toBe(true);
      expect(doneLabels.has("shared-pr-b")).toBe(true);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves non-terminal and unknown live states unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hm-live-state-non-terminal-"));
    const db = new FactsDB(join(dir, "facts.db"));
    try {
      await addTask(db, baseTask("issue-open", "Track acme/unknown issue #500"));
      await addTask(db, baseTask("issue-unknown", "Track acme/unknown issue #501"));
      await addTask(db, baseTask("pr-open", "Watch acme/unknown pull request #502"));
      await addTask(db, baseTask("pr-unknown", "Watch acme/unknown pr #503"));

      process.env.MOCK_GH_TABLE = JSON.stringify({
        "issue:acme/unknown#500": { state: "OPEN" },
        "issue:acme/unknown#501": { state: "MYSTERY" },
        "pr:acme/unknown#502": { state: "OPEN", mergedAt: null, closedAt: null },
        "pr:acme/unknown#503": { state: "DRAFT", mergedAt: null, closedAt: null },
      });

      const result = await reconcileActiveTaskLiveState(db, vectorDb, embeddings, { maxRequests: 10 });
      expect(result.checkedCount).toBe(4);
      expect(result.updatedCount).toBe(0);

      const { active, completed } = loadTaskLedgerFromFacts(db);
      expect(active.map((t) => t.label).sort()).toEqual(
        ["issue-open", "issue-unknown", "pr-open", "pr-unknown"].sort(),
      );
      expect(completed).toHaveLength(0);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
