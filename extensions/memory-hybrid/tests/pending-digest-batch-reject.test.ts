/**
 * Regression tests for #2098's digest batch-reject hygiene: duplicate detection (same
 * target/name, keep newest), age/confidence threshold candidate selection, and that apply()
 * only ever rejects the exact ids previewed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { applyDigestBatchReject, previewDigestBatchReject } from "../services/pending-digest-batch-reject.js";

function makeCfg(sqlitePath: string): HybridMemoryConfig {
  return {
    sqlitePath,
    personaProposals: { enabled: true },
  } as unknown as HybridMemoryConfig;
}

describe("pending digest batch-reject (#2098)", () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "digest-batch-reject-"));
    sqlitePath = join(dir, "facts.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("persona queue", () => {
    function backdatePersona(id: string, ageDays: number) {
      const raw = new DatabaseSync(join(dir, "proposals.db"));
      const createdAt = Math.floor(Date.now() / 1000) - ageDays * 86400;
      raw.prepare("UPDATE proposals SET created_at = ? WHERE id = ?").run(createdAt, id);
      raw.close();
    }

    it("flags all but the newest of duplicate (targetFile+title) proposals", () => {
      const store = new ProposalsDB(join(dir, "proposals.db"));
      const older = store.create({
        targetFile: "AGENTS.md",
        title: "Prefer concise commits",
        observation: "obs",
        suggestedChange: "change",
        confidence: 0.8,
        evidenceSessions: [],
      });
      const newer = store.create({
        targetFile: "AGENTS.md",
        title: "Prefer concise commits",
        observation: "obs2",
        suggestedChange: "change2",
        confidence: 0.8,
        evidenceSessions: [],
      });
      store.close();
      backdatePersona(older.id, 5);
      backdatePersona(newer.id, 1);

      const preview = previewDigestBatchReject({
        cfg: makeCfg(sqlitePath),
        queue: "persona",
        duplicatesOnly: true,
      });

      expect(preview.totalPending).toBe(2);
      expect(preview.candidates).toHaveLength(1);
      expect(preview.candidates[0].id).toBe(older.id);
      expect(preview.candidates[0].reasons.some((r) => r.startsWith("duplicate of"))).toBe(true);
    });

    it("selects candidates by age threshold and rejects only those ids on apply", () => {
      const store = new ProposalsDB(join(dir, "proposals.db"));
      const old = store.create({
        targetFile: "A.md",
        title: "Old one",
        observation: "o",
        suggestedChange: "c",
        confidence: 0.9,
        evidenceSessions: [],
      });
      const fresh = store.create({
        targetFile: "B.md",
        title: "Fresh one",
        observation: "o",
        suggestedChange: "c",
        confidence: 0.9,
        evidenceSessions: [],
      });
      store.close();
      backdatePersona(old.id, 45);
      backdatePersona(fresh.id, 1);

      const cfg = makeCfg(sqlitePath);
      const preview = previewDigestBatchReject({ cfg, queue: "persona", olderThanDays: 30 });
      expect(preview.candidates.map((c) => c.id)).toEqual([old.id]);

      const result = applyDigestBatchReject({ cfg, queue: "persona", ids: preview.candidates.map((c) => c.id) });
      expect(result).toEqual({ rejected: 1, failed: [] });

      const after = new ProposalsDB(join(dir, "proposals.db"));
      expect(after.get(old.id)?.status).toBe("rejected");
      expect(after.get(fresh.id)?.status).toBe("pending");
      after.close();
    });

    it("selects candidates by confidence threshold", () => {
      const store = new ProposalsDB(join(dir, "proposals.db"));
      const lowConf = store.create({
        targetFile: "A.md",
        title: "Low confidence",
        observation: "o",
        suggestedChange: "c",
        confidence: 0.2,
        evidenceSessions: [],
      });
      const highConf = store.create({
        targetFile: "B.md",
        title: "High confidence",
        observation: "o",
        suggestedChange: "c",
        confidence: 0.95,
        evidenceSessions: [],
      });
      store.close();

      const preview = previewDigestBatchReject({
        cfg: makeCfg(sqlitePath),
        queue: "persona",
        maxConfidence: 0.3,
      });
      expect(preview.candidates.map((c) => c.id)).toEqual([lowConf.id]);
      expect(preview.candidates[0].reasons.some((r) => r.includes("confidence"))).toBe(true);
      expect(preview.candidates.some((c) => c.id === highConf.id)).toBe(false);
    });

    it("apply() never rejects ids outside the ones explicitly passed in", () => {
      const store = new ProposalsDB(join(dir, "proposals.db"));
      const a = store.create({
        targetFile: "A.md",
        title: "A",
        observation: "o",
        suggestedChange: "c",
        confidence: 0.1,
        evidenceSessions: [],
      });
      const b = store.create({
        targetFile: "B.md",
        title: "B",
        observation: "o",
        suggestedChange: "c",
        confidence: 0.1,
        evidenceSessions: [],
      });
      store.close();

      // Both would match maxConfidence, but apply is only given `a`'s id.
      const result = applyDigestBatchReject({ cfg: makeCfg(sqlitePath), queue: "persona", ids: [a.id] });
      expect(result).toEqual({ rejected: 1, failed: [] });

      const after = new ProposalsDB(join(dir, "proposals.db"));
      expect(after.get(a.id)?.status).toBe("rejected");
      expect(after.get(b.id)?.status).toBe("pending");
      after.close();
    });
  });

  describe("tools queue", () => {
    it("flags duplicate tool proposals by name, keeping the newest", () => {
      const store = new ToolProposalStore(join(dir, "tool-proposals.db"));
      const older = store.create({
        name: "fetch_weather",
        description: "d1",
        parameters: "{}",
        rationale: "r",
        sourcePatterns: "[]",
        implementationHint: "h",
      });
      const newer = store.create({
        name: "fetch_weather",
        description: "d2",
        parameters: "{}",
        rationale: "r",
        sourcePatterns: "[]",
        implementationHint: "h",
      });
      store.close();
      const raw = new DatabaseSync(join(dir, "tool-proposals.db"));
      raw
        .prepare("UPDATE tool_proposals SET created_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 5 * 86400_000).toISOString(), older.id);
      raw
        .prepare("UPDATE tool_proposals SET created_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 1 * 86400_000).toISOString(), newer.id);
      raw.close();

      const preview = previewDigestBatchReject({
        cfg: makeCfg(sqlitePath),
        queue: "tools",
        duplicatesOnly: true,
      });
      expect(preview.candidates.map((c) => c.id)).toEqual([older.id]);

      const result = applyDigestBatchReject({
        cfg: makeCfg(sqlitePath),
        queue: "tools",
        ids: preview.candidates.map((c) => c.id),
      });
      expect(result).toEqual({ rejected: 1, failed: [] });

      const after = new ToolProposalStore(join(dir, "tool-proposals.db"));
      expect(after.getById(older.id)?.status).toBe("rejected");
      expect(after.getById(newer.id)?.status).toBe("proposed");
      after.close();
    });
  });

  describe("crystallization queue", () => {
    it("flags duplicate crystallization proposals by skill name, keeping the newest", () => {
      const store = new CrystallizationStore(join(dir, "crystallization-proposals.db"));
      const older = store.create({
        patternId: "p1",
        evidenceHash: "h1",
        skillName: "deploy-helper",
        skillContent: "content1",
        patternSnapshot: "{}",
      });
      const newer = store.create({
        patternId: "p2",
        evidenceHash: "h2",
        skillName: "deploy-helper",
        skillContent: "content2",
        patternSnapshot: "{}",
      });
      store.close();
      const raw = new DatabaseSync(join(dir, "crystallization-proposals.db"));
      raw
        .prepare("UPDATE crystallization_proposals SET created_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 5 * 86400_000).toISOString(), older.id);
      raw
        .prepare("UPDATE crystallization_proposals SET created_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 1 * 86400_000).toISOString(), newer.id);
      raw.close();

      const preview = previewDigestBatchReject({
        cfg: makeCfg(sqlitePath),
        queue: "crystallization",
        duplicatesOnly: true,
      });
      expect(preview.candidates.map((c) => c.id)).toEqual([older.id]);

      const result = applyDigestBatchReject({
        cfg: makeCfg(sqlitePath),
        queue: "crystallization",
        ids: preview.candidates.map((c) => c.id),
      });
      expect(result).toEqual({ rejected: 1, failed: [] });

      const after = new CrystallizationStore(join(dir, "crystallization-proposals.db"));
      expect(after.getById(older.id)?.status).toBe("rejected");
      expect(after.getById(newer.id)?.status).toBe("drafted");
      after.close();
    });
  });
});
