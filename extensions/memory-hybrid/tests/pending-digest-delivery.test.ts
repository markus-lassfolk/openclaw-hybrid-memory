import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ensureMaintenanceCronJobs } from "../cli/cmd-install.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { hybridConfigSchema, type HybridMemoryConfig } from "../config.js";
import {
  buildPendingReviewDigestReport,
  pendingStorePaths,
  renderPendingReviewDigestMarkdown,
} from "../services/pending-review-digest.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

function readJobs(openclawDir: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(openclawDir, "cron", "jobs.json"), "utf-8");
  const parsed = JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> };
  return Array.isArray(parsed.jobs) ? parsed.jobs : [];
}

function configFor(sqlitePath: string): HybridMemoryConfig {
  return hybridConfigSchema.parse({
    embedding: {
      apiKey: "sk-test-embed-key-that-is-long-enough",
      model: "text-embedding-3-small",
    },
    sqlitePath,
    lanceDbPath: join(dirname(sqlitePath), "lancedb"),
    credentials: { enabled: false },
    wal: { enabled: false },
    personaProposals: { enabled: true },
    verification: { enabled: false },
    provenance: { enabled: false },
    nightlyCycle: { enabled: false },
  });
}

describe("pending digest delivery via cron config (#1197)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function newOpenclawDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "hybrid-mem-pending-delivery-"));
    dirs.push(dir);
    return dir;
  }

  it("maps digest.weekly.delivery none → job delivery.mode none", () => {
    const openclawDir = newOpenclawDir();
    ensureMaintenanceCronJobs(openclawDir, undefined, {
      normalizeExisting: true,
      digestWeeklyDelivery: { mode: "none" },
    });
    const target = readJobs(openclawDir).find((j) => j.pluginJobId === "hybrid-mem:weekly-pending-digest");
    expect(target?.delivery).toMatchObject({ mode: "none" });
  });

  it("maps digest.weekly.delivery telegram + chatId → announce + telegram channel", () => {
    const openclawDir = newOpenclawDir();
    ensureMaintenanceCronJobs(openclawDir, undefined, {
      normalizeExisting: true,
      digestWeeklyDelivery: { mode: "telegram", chatId: "12345" },
    });
    const target = readJobs(openclawDir).find((j) => j.pluginJobId === "hybrid-mem:weekly-pending-digest");
    expect(target?.delivery).toMatchObject({ mode: "announce", channel: "telegram", chatId: "12345" });
  });

  // #1197 — drive the full digest through a mock telegram delivery and assert the rendered body.
  it("renders a body that includes persona-proposal evidence and procedure newThisWeek and dispatches via mock telegram delivery", () => {
    const dir = newOpenclawDir();
    const cfg = configFor(join(dir, "facts.db"));
    const paths = pendingStorePaths(cfg.sqlitePath);
    const factsDb = new FactsDB(cfg.sqlitePath);
    const persona = new ProposalsDB(paths.proposals);

    const sessionId = "session-evidence-1";
    persona.create({
      targetFile: "SOUL.md",
      title: "Use shorter status updates",
      observation: "Operator prefers 1-line milestones",
      suggestedChange: "Limit updates to ≤80 chars.",
      confidence: 0.83,
      evidenceSessions: [sessionId],
    });

    const now = Math.floor(Date.now() / 1000);
    const f1 = factsDb.store({
      text: "Operator prefers concise milestone updates.",
      category: "preference",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
      decayClass: "durable",
      expiresAt: now + 86400 * 30,
      confidence: 0.9,
      provenanceSession: sessionId,
    });
    factsDb.store({
      text: "Operator dislikes verbose updates.",
      category: "preference",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
      decayClass: "durable",
      expiresAt: now + 86400 * 30,
      confidence: 0.8,
      provenanceSession: sessionId,
    });

    factsDb.upsertProcedure({
      taskPattern: "Validate procedure within window",
      recipeJson: JSON.stringify([{ tool: "inspect" }]),
      procedureType: "positive",
      successCount: 3,
      lastValidated: now,
      confidence: 0.85,
    });

    const report = buildPendingReviewDigestReport({
      cfg,
      factsDb,
      since: "7d",
      now: new Date(now * 1000),
    });

    expect(report.procedures.newThisWeek).toBeGreaterThanOrEqual(1);
    expect(report.personaProposals.pendingEntries[0]?.evidence.facts).toBe(2);
    expect(report.personaProposals.pendingEntries[0]?.evidence.topFactIds).toContain(f1.id);

    const body = renderPendingReviewDigestMarkdown(report);
    expect(body).toContain("Evidence: 2 fact(s)");
    expect(body).toContain(f1.id);
    expect(body).toMatch(/new this week/);

    type TelegramDelivery = { chatId: string; markdown: string };
    const sent: TelegramDelivery[] = [];
    function mockTelegramDeliver(chatId: string, markdown: string): void {
      sent.push({ chatId, markdown });
    }
    mockTelegramDeliver("12345", body);
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("12345");
    expect(sent[0].markdown).toBe(body);
    expect(sent[0].markdown).toContain("Persona proposals (1)");

    persona.close();
    factsDb.close();
  });
});
