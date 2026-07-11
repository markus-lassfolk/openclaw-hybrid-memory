/**
 * Living-memory B1: free-text contradiction candidates. Vector neighbors at a cosine floor
 * (converted to the store's 1/(1+L2) score space) filtered hard — in-scope only, structured
 * entity+key pairs excluded, near-dups excluded, existing pairs idempotent — then an NLI verdict
 * gates recordContradiction with the nli_free_text audit marker and the CONTRADICTS link.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { cosineToVectorScore, runContradictionCandidates } from "../services/contradiction-candidates.js";

let dir: string;
let db: FactsDB;
const logger = { info: () => {}, warn: () => {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hybrid-nli-"));
  db = new FactsDB(join(dir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const cfg = { similarityFloor: 0.85, maxPairsPerRun: 40, minConfidence: 0.7, model: "test", fallbackModels: [] };

function storeFact(
  text: string,
  opts?: { entity?: string; key?: string; scope?: string; scopeTarget?: string; createdAt?: number },
): string {
  const id = db.store({
    text,
    entity: opts?.entity ?? null,
    key: opts?.key ?? null,
    value: null,
    category: "fact",
    importance: 0.5,
    source: "test",
    tags: [],
    ...(opts?.scope ? { scope: opts.scope, scopeTarget: opts.scopeTarget ?? null } : {}),
  } as never).id;
  if (opts?.createdAt !== undefined) {
    db.getRawDb().prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(opts.createdAt, id);
  }
  return id;
}

/** Fake vector stack: every fact is everyone's neighbor at the given score. */
function fakeDeps(neighborScore: number, verdict: { verdict: string; confidence: number }, calls?: string[][]) {
  return {
    factsDb: db,
    vectorDb: {
      search: async () => {
        const rows = db.getRawDb().prepare("SELECT id FROM facts WHERE superseded_at IS NULL").all() as Array<{
          id: string;
        }>;
        return rows.map((r) => ({ entry: db.getById(r.id), score: neighborScore, backend: "lancedb" }));
      },
    },
    embeddings: { embed: async () => [0.1, 0.2] },
    openai: {
      chat: {
        completions: {
          create: async (req: { messages?: unknown } & Record<string, unknown>) => {
            calls?.push([JSON.stringify(req)]);
            return { choices: [{ message: { content: JSON.stringify({ ...verdict, reason: "test" }) } }] };
          },
        },
      },
    },
  } as never;
}

const CONTRA = { verdict: "contradiction", confidence: 0.9 };
const MID_SCORE = cosineToVectorScore(0.9); // above the 0.85 floor, below the near-dup ceiling

describe("cosine → vector score conversion", () => {
  it("pins the documented conversion (0.85 → 1/(1+√0.3) ≈ 0.6461)", () => {
    expect(cosineToVectorScore(0.85)).toBeCloseTo(1 / (1 + Math.sqrt(0.3)), 6);
    expect(cosineToVectorScore(0.85)).toBeCloseTo(0.6461, 3);
    expect(cosineToVectorScore(1)).toBe(1);
  });
});

describe("free-text contradiction candidates", () => {
  it("records an NLI-confirmed pair with CONTRADICTS link, audit marker, and −0.2 on the old fact", async () => {
    const older = storeFact("The deploy pipeline uses the blue environment for production traffic", {
      createdAt: Math.floor(Date.now() / 1000) - 3600,
    });
    const newer = storeFact("Production traffic is served exclusively by the green environment now");

    const r = await runContradictionCandidates(fakeDeps(MID_SCORE, CONTRA), cfg, {}, logger);

    expect(r.recorded).toBe(1);
    const contra = db
      .getRawDb()
      .prepare("SELECT fact_id_new, fact_id_old, heuristic_signals, heuristic_score FROM contradictions")
      .get() as { fact_id_new: string; fact_id_old: string; heuristic_signals: string; heuristic_score: number };
    expect(contra.fact_id_new).toBe(newer);
    expect(contra.fact_id_old).toBe(older);
    expect(JSON.parse(contra.heuristic_signals)).toEqual(["nli_free_text"]);
    expect(contra.heuristic_score).toBeCloseTo(0.9);
    const link = db.getRawDb().prepare("SELECT link_type FROM memory_links WHERE link_type = 'CONTRADICTS'").get() as {
      link_type: string;
    };
    expect(link.link_type).toBe("CONTRADICTS");
    const oldFact = db.getById(older);
    expect(oldFact?.confidence).toBeLessThan(1); // −0.2 penalty applied by recordContradiction

    // Idempotent: second run skips the existing pair without another record.
    const again = await runContradictionCandidates(fakeDeps(MID_SCORE, CONTRA), cfg, {}, logger);
    expect(again.recorded).toBe(0);
    expect(again.skippedExisting).toBeGreaterThanOrEqual(1);
  });

  it("skips cross-scope neighbors and same-entity+key (structured) pairs", async () => {
    storeFact("User prefers dark mode in every editor", { entity: "user", key: "theme" });
    storeFact("User prefers light mode in every editor", { entity: "user", key: "theme" });
    storeFact("Session-scoped note about themes", { scope: "session", scopeTarget: "sess-1" });

    const r = await runContradictionCandidates(fakeDeps(MID_SCORE, CONTRA), cfg, {}, logger);

    expect(r.recorded).toBe(0);
    expect(r.skippedStructured).toBeGreaterThanOrEqual(1);
  });

  it("skips near-duplicates (consolidation's territory) and neutral/low-confidence verdicts", async () => {
    storeFact("The service listens on port 8080 in staging");
    storeFact("Staging runs the service on port 8080");

    const nearDup = await runContradictionCandidates(fakeDeps(cosineToVectorScore(0.99), CONTRA), cfg, {}, logger);
    expect(nearDup.recorded).toBe(0);
    expect(nearDup.llmCalls).toBe(0);

    const neutral = await runContradictionCandidates(
      fakeDeps(MID_SCORE, { verdict: "neutral", confidence: 0.95 }),
      cfg,
      {},
      logger,
    );
    expect(neutral.recorded).toBe(0);
    expect(neutral.llmCalls).toBeGreaterThan(0);

    const lowConf = await runContradictionCandidates(
      fakeDeps(MID_SCORE, { verdict: "contradiction", confidence: 0.4 }),
      cfg,
      {},
      logger,
    );
    expect(lowConf.recorded).toBe(0);
  });

  it("caps LLM calls at maxPairsPerRun and dryRun records nothing", async () => {
    for (let i = 0; i < 8; i++) {
      storeFact(`Fully distinct operational statement number ${i} about a different subsystem entirely`);
    }
    const capped = await runContradictionCandidates(
      fakeDeps(MID_SCORE, CONTRA),
      { ...cfg, maxPairsPerRun: 3 },
      {},
      logger,
    );
    expect(capped.llmCalls).toBeLessThanOrEqual(3);

    const dry = await runContradictionCandidates(fakeDeps(MID_SCORE, CONTRA), cfg, { dryRun: true }, logger);
    expect(dry.recorded).toBeGreaterThan(0);
    expect((db.getRawDb().prepare("SELECT COUNT(*) AS n FROM contradictions").get() as { n: number }).n).toBe(3); // only from the capped run above
  });

  it("only scans recent facts (48h window)", async () => {
    const old = Math.floor(Date.now() / 1000) - 5 * 86_400;
    storeFact("Ancient statement one about the deployment order", { createdAt: old });
    storeFact("Ancient statement two contradicting the deployment order", { createdAt: old });

    const r = await runContradictionCandidates(fakeDeps(MID_SCORE, CONTRA), cfg, {}, logger);
    expect(r.scanned).toBe(0);
    expect(r.llmCalls).toBe(0);
  });
});
