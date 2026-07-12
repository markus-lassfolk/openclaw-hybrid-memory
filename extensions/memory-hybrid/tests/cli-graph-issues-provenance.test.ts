// @ts-nocheck
/**
 * Regression tests for #2090: CLI parity for link/issues/provenance/graph capabilities that
 * previously only existed as agent tools (memory_link, memory_issue_*, memory_provenance,
 * memory_path).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageIssueTools } from "../cli/commands/manage/register-issue-tools.js";
import { registerManageLinkTools } from "../cli/commands/manage/register-link-tools.js";
import { registerManageProvenanceTools } from "../cli/commands/manage/register-provenance-tools.js";
import { registerManageStorageGraphAudit } from "../cli/commands/manage/register-storage-graph-audit.js";
import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";

const { FactsDB, IssueStore, ProvenanceService } = _testing;

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;
let logs: string[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hm-cli-graph-issues-provenance-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  });
});

afterEach(() => {
  factsDb.close();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function storeFact(text: string) {
  return factsDb.store({
    text,
    category: "fact",
    importance: 0.5,
    entity: null,
    key: null,
    value: null,
    source: "test",
  });
}

function makeCfg(sqlitePath: string) {
  const cfg = hybridConfigSchema.parse({
    embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test-key-12345678" },
    sqlitePath,
  });
  // provenance.enabled defaults to false (opt-in) — tests that exercise the provenance CLI path
  // need it explicitly turned on; the dedicated "disabled" test overrides it back to false.
  (cfg as unknown as { provenance: unknown }).provenance = { enabled: true };
  return cfg;
}

describe("link CLI (#2090)", () => {
  function makeProgram(): Command {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerManageLinkTools(mem, { factsDb, cfg: makeCfg(join(tmpDir, "facts.db")) } as unknown as ManageBindings);
    return mem;
  }

  it("create rejects an invalid --type", async () => {
    const a = storeFact("fact a");
    const b = storeFact("fact b");
    const mem = makeProgram();
    await expect(
      mem.parseAsync(["link", "create", a.id, b.id, "--type", "NOT_A_TYPE"], { from: "user" }),
    ).rejects.toThrow(/--type must be one of/);
  });

  it("create rejects when source or target fact does not exist", async () => {
    const a = storeFact("fact a");
    const mem = makeProgram();
    await expect(
      mem.parseAsync(["link", "create", a.id, "nonexistent", "--type", "RELATED_TO"], { from: "user" }),
    ).rejects.toThrow(/Target fact not found/);
  });

  it("create rejects self-links", async () => {
    const a = storeFact("fact a");
    const mem = makeProgram();
    await expect(
      mem.parseAsync(["link", "create", a.id, a.id, "--type", "RELATED_TO"], { from: "user" }),
    ).rejects.toThrow(/Cannot link a fact to itself/);
  });

  it("create makes a real link and list shows it in both directions", async () => {
    const a = storeFact("fact a");
    const b = storeFact("fact b");
    const mem = makeProgram();

    await mem.parseAsync(["link", "create", a.id, b.id, "--type", "RELATED_TO", "--strength", "0.7"], {
      from: "user",
    });
    expect(logs.some((l) => l.includes("Created RELATED_TO link"))).toBe(true);
    expect(factsDb.getLinksFrom(a.id)).toHaveLength(1);

    logs.length = 0;
    const listMem = makeProgram();
    await listMem.parseAsync(["link", "list", a.id, "--json"], { from: "user" });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.outgoing).toHaveLength(1);
    expect(parsed.outgoing[0]).toMatchObject({ linkType: "RELATED_TO", targetFactId: b.id, strength: 0.7 });
  });

  it("create with --type CONTRADICTS records a bidirectional contradiction instead of a plain link", async () => {
    const a = storeFact("fact a");
    const b = storeFact("fact b");
    const mem = makeProgram();

    await mem.parseAsync(["link", "create", a.id, b.id, "--type", "CONTRADICTS", "--json"], { from: "user" });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.contradictionId).toBeTruthy();
    expect(parsed.linkType).toBe("CONTRADICTS");
  });

  it("delete removes a link and reports not-found for an unknown id", async () => {
    const a = storeFact("fact a");
    const b = storeFact("fact b");
    const linkId = factsDb.createLink(a.id, b.id, "RELATED_TO", 1.0);
    const mem = makeProgram();

    await mem.parseAsync(["link", "delete", linkId, "--json"], { from: "user" });
    expect(JSON.parse(logs.join(""))).toMatchObject({ linkId, deleted: true });
    expect(factsDb.getLinksFrom(a.id)).toHaveLength(0);

    logs.length = 0;
    const mem2 = makeProgram();
    await mem2.parseAsync(["link", "delete", "nonexistent-id", "--json"], { from: "user" });
    expect(JSON.parse(logs.join(""))).toMatchObject({ deleted: false });
    expect(process.exitCode).toBe(1);
  });
});

describe("issues CLI (#2090)", () => {
  let issueStore: InstanceType<typeof IssueStore>;

  beforeEach(() => {
    issueStore = new IssueStore(join(tmpDir, "issues.db"));
  });

  afterEach(() => {
    issueStore.close();
  });

  function makeProgram(): Command {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerManageIssueTools(mem, {
      factsDb,
      issueStore,
      cfg: makeCfg(join(tmpDir, "facts.db")),
    } as unknown as ManageBindings);
    return mem;
  }

  function makeProgramWithoutStore(): Command {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerManageIssueTools(mem, {
      factsDb,
      issueStore: null,
      cfg: makeCfg(join(tmpDir, "facts.db")),
    } as unknown as ManageBindings);
    return mem;
  }

  it("errors clearly when issueStore is unavailable", async () => {
    const mem = makeProgramWithoutStore();
    await expect(mem.parseAsync(["issues", "create", "Title", "--symptoms", "a,b"], { from: "user" })).rejects.toThrow(
      /Issue tracking is unavailable/,
    );
  });

  it("create stores an issue with parsed symptoms/tags and rejects invalid severity", async () => {
    const mem = makeProgram();
    await expect(
      mem.parseAsync(["issues", "create", "Title", "--symptoms", "a", "--severity", "extreme"], { from: "user" }),
    ).rejects.toThrow(/--severity must be one of/);

    const mem2 = makeProgram();
    await mem2.parseAsync(
      ["issues", "create", "Broken thing", "--symptoms", " crashes , hangs ", "--severity", "high", "--json"],
      { from: "user" },
    );
    const created = JSON.parse(logs.join(""));
    expect(created.symptoms).toEqual(["crashes", "hangs"]);
    expect(created.severity).toBe("high");
    expect(created.status).toBe("open");
  });

  it("update transitions status and rejects invalid transitions/status values", async () => {
    const issue = issueStore.create({ title: "T", symptoms: ["s"], severity: "low" });

    const mem = makeProgram();
    await expect(
      mem.parseAsync(["issues", "update", issue.id, "--status", "not-a-status"], { from: "user" }),
    ).rejects.toThrow(/--status must be one of/);

    const mem2 = makeProgram();
    await expect(
      mem2.parseAsync(["issues", "update", issue.id, "--status", "verified"], { from: "user" }),
    ).rejects.toThrow();

    const mem3 = makeProgram();
    await mem3.parseAsync(
      ["issues", "update", issue.id, "--status", "diagnosed", "--root-cause", "found it", "--json"],
      {
        from: "user",
      },
    );
    const updated = JSON.parse(logs.join(""));
    expect(updated.status).toBe("diagnosed");
    expect(updated.rootCause).toBe("found it");
  });

  it("list filters by status/severity and rejects invalid filter values", async () => {
    issueStore.create({ title: "A", symptoms: ["x"], severity: "low" });
    issueStore.create({ title: "B", symptoms: ["y"], severity: "critical" });

    const mem = makeProgram();
    await expect(mem.parseAsync(["issues", "list", "--status", "bogus"], { from: "user" })).rejects.toThrow(
      /--status contains an invalid value/,
    );

    const mem2 = makeProgram();
    await mem2.parseAsync(["issues", "list", "--severity", "critical", "--json"], { from: "user" });
    const list = JSON.parse(logs.join(""));
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("B");
  });

  it("search finds issues by title/symptom text", async () => {
    issueStore.create({ title: "Database connection flaky", symptoms: ["timeout"], severity: "medium" });
    issueStore.create({ title: "Unrelated", symptoms: ["other"], severity: "low" });

    const mem = makeProgram();
    await mem.parseAsync(["issues", "search", "flaky", "--json"], { from: "user" });
    const results = JSON.parse(logs.join(""));
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("flaky");
  });

  it("show prints one issue and errors for an unknown id", async () => {
    const issue = issueStore.create({ title: "Shown", symptoms: ["s"], severity: "low" });
    const mem = makeProgram();
    await mem.parseAsync(["issues", "show", issue.id, "--json"], { from: "user" });
    expect(JSON.parse(logs.join("")).id).toBe(issue.id);

    const mem2 = makeProgram();
    await expect(mem2.parseAsync(["issues", "show", "nonexistent"], { from: "user" })).rejects.toThrow(
      /Issue not found/,
    );
  });

  it("link-fact associates a fact and rejects a missing fact", async () => {
    const issue = issueStore.create({ title: "Linkable", symptoms: ["s"], severity: "low" });
    const fact = storeFact("supporting fact");

    const mem = makeProgram();
    await mem.parseAsync(["issues", "link-fact", issue.id, fact.id], { from: "user" });
    expect(issueStore.get(issue.id)?.relatedFacts).toContain(fact.id);

    const mem2 = makeProgram();
    await expect(
      mem2.parseAsync(["issues", "link-fact", issue.id, "nonexistent-fact"], { from: "user" }),
    ).rejects.toThrow(/Fact not found/);
  });
});

describe("provenance CLI (#2090)", () => {
  let provenanceService: InstanceType<typeof ProvenanceService>;

  beforeEach(() => {
    provenanceService = new ProvenanceService(join(tmpDir, "provenance.db"));
  });

  afterEach(() => {
    provenanceService.close();
  });

  function makeProgram(overrides: Partial<ManageBindings> = {}): Command {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerManageProvenanceTools(mem, {
      factsDb,
      provenanceService,
      cfg: makeCfg(join(tmpDir, "facts.db")),
      ...overrides,
    } as unknown as ManageBindings);
    return mem;
  }

  it("errors for an unknown fact id", async () => {
    const mem = makeProgram();
    await expect(mem.parseAsync(["provenance", "nonexistent"], { from: "user" })).rejects.toThrow(/Fact not found/);
  });

  it("errors clearly when provenanceService is unavailable", async () => {
    const fact = storeFact("some fact");
    const mem = makeProgram({ provenanceService: undefined });
    await expect(mem.parseAsync(["provenance", fact.id], { from: "user" })).rejects.toThrow(
      /Provenance service is unavailable/,
    );
  });

  it("respects provenance.enabled=false", async () => {
    const fact = storeFact("some fact");
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const cfg = makeCfg(join(tmpDir, "facts.db"));
    (cfg as unknown as { provenance: unknown }).provenance = { enabled: false };
    registerManageProvenanceTools(mem, { factsDb, provenanceService, cfg } as unknown as ManageBindings);
    await expect(mem.parseAsync(["provenance", fact.id], { from: "user" })).rejects.toThrow(
      /Provenance tracking is disabled/,
    );
  });

  it("returns the provenance chain including edges", async () => {
    const fact = storeFact("derived fact");
    provenanceService.addEdge(fact.id, {
      edgeType: "CONSOLIDATED_FROM",
      sourceType: "consolidation",
      sourceId: "src-1",
      sourceText: "original text",
    });

    const mem = makeProgram();
    await mem.parseAsync(["provenance", fact.id, "--json"], { from: "user" });
    const chain = JSON.parse(logs.join(""));
    expect(chain.fact.id).toBe(fact.id);
    expect(chain.edges).toHaveLength(1);
    expect(chain.edges[0]).toMatchObject({ edgeType: "CONSOLIDATED_FROM", sourceId: "src-1" });
  });
});

describe("graph get/path CLI (#2090)", () => {
  function makeProgram(): Command {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerManageStorageGraphAudit(mem, {
      factsDb,
      vectorDb: {},
      getMemoryCategories: () => [],
      cfg: makeCfg(join(tmpDir, "facts.db")),
      ctx: {},
    } as unknown as ManageBindings);
    return mem;
  }

  it("get shows a fact plus its outgoing/incoming links", async () => {
    const a = storeFact("fact a");
    const b = storeFact("fact b");
    factsDb.createLink(a.id, b.id, "RELATED_TO", 1.0);

    const mem = makeProgram();
    await mem.parseAsync(["graph", "get", a.id, "--json"], { from: "user" });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.fact.id).toBe(a.id);
    expect(parsed.outgoing).toHaveLength(1);
  });

  it("get errors for an unknown fact id", async () => {
    const mem = makeProgram();
    await mem.parseAsync(["graph", "get", "nonexistent"], { from: "user" });
    expect(process.exitCode).toBe(1);
  });

  it("path finds the shortest route between two linked facts", async () => {
    const a = storeFact("fact a");
    const b = storeFact("fact b");
    const c = storeFact("fact c");
    factsDb.createLink(a.id, b.id, "RELATED_TO", 1.0);
    factsDb.createLink(b.id, c.id, "RELATED_TO", 1.0);

    const mem = makeProgram();
    await mem.parseAsync(["graph", "path", a.id, c.id, "--json"], { from: "user" });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.found).toBe(true);
    expect(parsed.hops).toBe(2);
  });

  it("path reports not-found with a nonzero exit when no path exists", async () => {
    const a = storeFact("fact a");
    const b = storeFact("isolated fact");

    const mem = makeProgram();
    await mem.parseAsync(["graph", "path", a.id, b.id, "--json"], { from: "user" });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.found).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("path rejects an unresolvable endpoint", async () => {
    const a = storeFact("fact a");
    const mem = makeProgram();
    await mem.parseAsync(["graph", "path", a.id, "nonexistent"], { from: "user" });
    expect(process.exitCode).toBe(1);
  });
});
