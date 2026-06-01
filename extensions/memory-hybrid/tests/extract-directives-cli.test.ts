import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import { runExtractDirectivesForCli } from "../cli/cmd-extract-directives.js";

function writeSession(tmpDir: string, fileName: string, messages: string[]): void {
  const lines = messages.map((text, i) =>
    JSON.stringify({
      type: "message",
      message: {
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text }],
      },
    }),
  );
  writeFileSync(join(tmpDir, fileName), lines.join("\n"), "utf-8");
}

describe("runExtractDirectivesForCli", () => {
  let dir: string | null = null;
  let db: FactsDB | null = null;

  afterEach(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    db = null;
    dir = null;
  });

  it("stores durable directives with extraction metadata and marks partial when rejecting metadata envelopes", async () => {
    dir = mkdtempSync(join(tmpdir(), "extract-directives-cli-"));
    db = new FactsDB(join(dir, "facts.db"));
    writeSession(dir, "2026-05-27-directives.jsonl", [
      'Sender (untrusted metadata): ```json {"label":"M","id":"5730923583"} ``` Make a rule that you will never file Issues.',
      "Acknowledged.",
      "From now on, always verify backups before running a migration.",
      "Will do.",
    ]);
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await runExtractDirectivesForCli(
      {
        factsDb: db,
        vectorDb: {
          delete: vi.fn().mockResolvedValue(false),
          search: vi.fn().mockResolvedValue([]),
        },
        embeddings: { embed: vi.fn().mockResolvedValue([0.1]) },
        cfg: {
          procedures: { sessionsDir: dir },
          store: { fuzzyDedupe: true },
          extraction: { preFilter: { enabled: false } },
          llm: { providers: { ollama: {} } },
        },
        logger,
      } as any,
      { days: 30 },
    );

    expect(result.stored).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.partial).toBe(true);
    expect(db.getScanCursor("extract-directives")).toBeNull();

    const matches = db.search("verify backups", 5, { includeSuperseded: true, tierFilter: "all" });
    const stored = matches.find((item) => item.entry.source.startsWith("directive:"))?.entry;
    expect(stored).toBeDefined();
    expect(stored?.text.toLowerCase()).toContain("always verify backups");
    expect(stored?.extractionMethod).toBe("directive-extract:regex-heuristic-v2");
    expect(stored?.extractionConfidence).toBeGreaterThan(0);
    expect(stored?.confidence).toBeGreaterThan(0);
    expect(stored?.tags).toContain("directive-extract");
    expect(result.directiveDedupeMode).toBe("vector");
  });

  it("reports degraded dedupe when lexical-only fallback is used", async () => {
    dir = mkdtempSync(join(tmpdir(), "extract-directives-cli-"));
    db = new FactsDB(join(dir, "facts.db"));
    writeSession(dir, "2026-05-27-directives-ok.jsonl", ["From now on, always run lint before build.", "Got it."]);
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await runExtractDirectivesForCli(
      {
        factsDb: db,
        vectorDb: {
          delete: vi.fn().mockResolvedValue(false),
          search: vi.fn().mockResolvedValue([]),
        },
        embeddings: { embed: vi.fn().mockRejectedValue(new Error("embedding unavailable")) },
        cfg: {
          procedures: { sessionsDir: dir },
          store: { fuzzyDedupe: true },
          extraction: { preFilter: { enabled: false } },
          llm: { providers: { ollama: {} } },
        },
        logger,
      } as any,
      { days: 30 },
    );

    expect(result.stored).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.partial).toBe(false);
    expect(result.dedupeDegraded).toBe(true);
    expect(result.directiveDedupeMode).toBe("lexical-only");
    expect(db.getScanCursor("extract-directives")).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("extract-directives DEGRADED"));
  });

  it("dedupes near-duplicate directives on the CLI extraction path using vector candidates", async () => {
    dir = mkdtempSync(join(tmpdir(), "extract-directives-cli-"));
    db = new FactsDB(join(dir, "facts.db"), { fuzzyDedupe: true });
    const firstDirective = "From now on, always run lint before build and before deployment locally.";
    const secondDirective = "From now on, always run lint before build and before deployment locally nightly.";
    writeSession(dir, "2026-05-27-directives-dupe.jsonl", [firstDirective, "Noted.", secondDirective, "Understood."]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const FIRST_DIRECTIVE_EMBEDDING = [1];
    const SECOND_DIRECTIVE_EMBEDDING = [2];
    const SECOND_DIRECTIVE_EMBEDDING_FIRST_ELEMENT = SECOND_DIRECTIVE_EMBEDDING[0];
    const embeddings = {
      embed: vi.fn(async (text: string) =>
        text === secondDirective ? SECOND_DIRECTIVE_EMBEDDING : FIRST_DIRECTIVE_EMBEDDING,
      ),
    };
    const vectorDb = {
      delete: vi.fn().mockResolvedValue(false),
      search: vi.fn(async (vector: number[]) => {
        if (vector[0] !== SECOND_DIRECTIVE_EMBEDDING_FIRST_ELEMENT) return [];
        const existing = db!
          .search(firstDirective, 1, {
            includeSuperseded: true,
            tierFilter: "all",
          })
          .at(0)?.entry;
        if (!existing) return [];
        return [{ entry: { id: existing.id }, score: 0.95 }];
      }),
    };

    const result = await runExtractDirectivesForCli(
      {
        factsDb: db,
        vectorDb,
        embeddings,
        cfg: {
          procedures: { sessionsDir: dir },
          store: {
            fuzzyDedupe: true,
            sourceProfiles: {
              "directive:*": {
                vectorThreshold: 0.85,
                lexicalJaccard: 1,
                onDuplicate: "skip",
              },
            },
          },
          extraction: { preFilter: { enabled: false } },
          llm: { providers: { ollama: {} } },
        },
        logger,
      } as any,
      { days: 30 },
    );

    expect(result.incidents.length).toBe(2);
    expect(result.stored).toBe(1);
    expect(result.rejected).toBe(0);
    expect(db.directivesCount()).toBe(1);
    expect(result.dedupeDegraded).toBe(false);
    expect(result.directiveDedupeMode).toBe("vector");
    expect(vectorDb.search).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("extract-directives DEGRADED"));
  });
});
