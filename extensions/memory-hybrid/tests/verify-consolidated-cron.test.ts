import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";

describe("runVerifyForCli - consolidated maintenance cron", () => {
  let homeDir: string | null = null;

  afterEach(() => {
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = null;
    }
    vi.unstubAllEnvs();
  });

  function writeCronStore(jobs: unknown[]): void {
    homeDir = mkdtempSync(join(tmpdir(), "oc-verify-consolidated-"));
    const openclawDir = join(homeDir, ".openclaw");
    mkdirSync(join(openclawDir, "cron"), { recursive: true });
    writeFileSync(
      join(openclawDir, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { model: { primary: "openai/gpt-4.1-mini" } } } }, null, 2),
    );
    writeFileSync(join(openclawDir, "cron", "jobs.json"), JSON.stringify({ jobs }, null, 2), "utf-8");
    vi.stubEnv("HOME", homeDir);
  }

  function buildCtx() {
    const cfg = hybridConfigSchema.parse({
      mode: "local",
      embedding: { provider: "ollama", model: "nomic-embed-text", dimensions: 768 },
      llm: { default: ["openai/gpt-4.1-mini"] },
      personaProposals: { enabled: true },
    });
    return {
      cfg,
      factsDb: {
        count: () => 0,
        getRawDb: () => ({
          prepare: () => ({
            get: () => undefined,
          }),
        }),
      },
      vectorDb: {
        count: () => Promise.resolve(0),
        isLanceDbAvailable: () => true,
        ensureInitialized: () => Promise.resolve(),
        getVectorDim: () => 768,
        isMemoriesVectorSchemaValid: () => true,
      },
      embeddings: {
        dimensions: 768,
        embed: () => Promise.resolve(new Float32Array(768)),
        modelName: "nomic-embed-text",
      },
      credentialsDb: null,
      resolvedSqlitePath: ":memory:",
      resolvedLancePath: "/tmp/test-lance",
      openai: null,
    };
  }

  it("reports maintenance-nightly instead of missing legacy jobs in consolidated mode", async () => {
    writeCronStore([
      {
        pluginJobId: "hybrid-mem:maintenance-nightly",
        name: "maintenance-nightly",
        enabled: true,
        schedule: { kind: "cron", expr: "0 2 * * *" },
        payload: { kind: "agentTurn", message: "openclaw hybrid-mem maintenance nightly --verbose" },
      },
    ]);

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: false }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).toContain("consolidated orchestrator");
    expect(out).toContain("Gateway cron:");
    expect(out).toMatch(/maintenance-nightly/);
    expect(out).not.toContain("nightly-memory-sweep           missing");
    expect(out).not.toContain("weekly-reflection              missing");
    expect(out).not.toContain("nightly-dream-cycle            missing");
  });

  it("lists config-gated orchestrator modules with internal step names", async () => {
    writeCronStore([
      {
        pluginJobId: "hybrid-mem:maintenance-nightly",
        name: "maintenance-nightly",
        enabled: true,
        schedule: { kind: "cron", expr: "0 2 * * *" },
        payload: { kind: "agentTurn", message: "openclaw hybrid-mem maintenance nightly --verbose" },
      },
    ]);

    const ctx = buildCtx() as Record<string, unknown>;
    (ctx.cfg as Record<string, unknown>).nightlyCycle = { enabled: true };

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(ctx as never, { fix: false }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).toContain("Config-gated modules");
    expect(out).toContain("dream-cycle-core");
    expect(out).toContain("nightlyCycle.enabled");
    expect(out).not.toContain("nightly-dream-cycle");
  });

  it("verify --fix disables superseded legacy jobs and keeps maintenance-nightly", async () => {
    writeCronStore([
      {
        pluginJobId: "hybrid-mem:nightly-distill",
        name: "nightly-memory-sweep",
        enabled: true,
        schedule: { kind: "cron", expr: "0 2 * * *" },
        payload: { kind: "agentTurn", message: "legacy sweep" },
      },
      {
        pluginJobId: "hybrid-mem:weekly-reflection",
        name: "weekly-reflection",
        enabled: true,
        schedule: { kind: "cron", expr: "0 3 * * 0" },
        payload: { kind: "agentTurn", message: "legacy reflect" },
      },
    ]);

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: true }, { log: (m) => lines.push(m) });

    const jobsPath = join(homeDir!, ".openclaw", "cron", "jobs.json");
    const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
    const legacy = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:nightly-distill");
    const consolidated = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:maintenance-nightly");

    expect(legacy?.enabled).toBe(false);
    expect(legacy?.superseded).toBe(true);
    expect(consolidated?.enabled).not.toBe(false);
    expect(lines.join("\n")).toContain("maintenance-nightly");
  });

  it("warns when consolidated mode still has enabled weekly-audit-health legacy job", async () => {
    writeCronStore([
      {
        pluginJobId: "hybrid-mem:maintenance-nightly",
        name: "maintenance-nightly",
        enabled: true,
        schedule: { kind: "cron", expr: "0 2 * * *" },
        payload: { kind: "agentTurn", message: "openclaw hybrid-mem maintenance nightly --verbose" },
      },
      {
        pluginJobId: "hybrid-mem:weekly-audit-health",
        name: "weekly-audit-health",
        enabled: true,
        schedule: { kind: "cron", expr: "0 5 * * 0" },
        payload: { kind: "agentTurn", message: "openclaw hybrid-mem audit health --strict --json" },
      },
    ]);

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: false }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).toContain("weekly-audit-health");
    expect(out).toMatch(/Legacy per-task cron jobs still enabled/i);
  });

  it("does not warn when workshop-approval-reminder is enabled under consolidated mode (#1925)", async () => {
    writeCronStore([
      {
        pluginJobId: "hybrid-mem:maintenance-nightly",
        name: "maintenance-nightly",
        enabled: true,
        schedule: { kind: "cron", expr: "0 2 * * *" },
        payload: { kind: "agentTurn", message: "openclaw hybrid-mem maintenance nightly --verbose" },
      },
      {
        pluginJobId: "hybrid-mem:workshop-approval-reminder",
        name: "workshop-approval-reminder",
        enabled: true,
        schedule: { kind: "cron", expr: "50 1,13 * * *" },
        payload: { kind: "agentTurn", message: "Workshop approval reminder." },
      },
    ]);

    const ctx = buildCtx() as Record<string, unknown>;
    (ctx.cfg as Record<string, unknown>).workshop = { enabled: true };

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(ctx as never, { fix: false }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).not.toMatch(/Legacy per-task cron jobs still enabled.*workshop-approval-reminder/i);
  });

  it("verify --fix keeps enabled workshop-approval-reminder under consolidated mode (#1925)", async () => {
    writeCronStore([
      {
        pluginJobId: "hybrid-mem:nightly-distill",
        name: "nightly-memory-sweep",
        enabled: true,
        schedule: { kind: "cron", expr: "0 2 * * *" },
        payload: { kind: "agentTurn", message: "legacy sweep" },
      },
      {
        pluginJobId: "hybrid-mem:workshop-approval-reminder",
        name: "workshop-approval-reminder",
        enabled: true,
        schedule: { kind: "cron", expr: "50 1,13 * * *" },
        payload: { kind: "agentTurn", message: "Workshop approval reminder." },
      },
    ]);

    const ctx = buildCtx() as Record<string, unknown>;
    (ctx.cfg as Record<string, unknown>).workshop = { enabled: true };

    const { runVerifyForCli } = await import("../cli/handlers.js");
    await runVerifyForCli(ctx as never, { fix: true }, { log: () => {} });

    const jobsPath = join(homeDir!, ".openclaw", "cron", "jobs.json");
    const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
    const legacy = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:nightly-distill");
    const workshop = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:workshop-approval-reminder");

    expect(legacy?.enabled).toBe(false);
    expect(workshop?.enabled).toBe(true);
    expect(workshop?.superseded).not.toBe(true);
  });
});
