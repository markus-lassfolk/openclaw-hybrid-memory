/**
 * `enrich-entities` and `extract-implicit`, run via `maintenance step <name>`, previously only
 * surfaced the orchestrator's generic "still running after Ns" heartbeat for the whole step
 * duration — no phase/counter progress of their own, unlike distill and passive-observer (#2038).
 * Both already accept an `onProgress` callback; the step-runner registrations now wire a
 * throttled-logging callback into it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { buildCliMaintenanceRunners } from "../cli/commands/manage/maintenance-step-runners.js";

describe("enrich-entities / extract-implicit step-runner progress logging (#2038)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs throttled progress for enrich-entities via the onProgress callback wired into runEntityEnrichment", async () => {
    const logLines: string[] = [];
    const logger = { info: (s: string) => logLines.push(s), warn: () => {} };

    const bindings = {
      factsDb: { getRawDb: () => ({}) },
      cfg: {},
      logger,
      runEntityEnrichment: vi.fn(async (opts: { onProgress?: (p: unknown) => void }) => {
        opts.onProgress?.({ processed: 3, total: 10, factsEnriched: 2, mentions: 1, accepted: 2, rejected: 0 });
        return { processed: 10, factsEnriched: 4, llmFailures: 0, stopReason: "completed" };
      }),
    } as unknown as ManageBindings;

    const runner = buildCliMaintenanceRunners(bindings).get("enrich-entities");
    expect(runner).toBeDefined();
    await runner?.();

    expect(logLines.some((l) => l.includes("enrich-entities — progress:") && l.includes("processed=3/10"))).toBe(true);
  });

  it("logs throttled progress for extract-implicit via the onProgress callback wired into runExtractImplicitFeedback", async () => {
    const logLines: string[] = [];
    const logger = { info: (s: string) => logLines.push(s), warn: () => {} };

    const bindings = {
      factsDb: { getRawDb: () => ({}) },
      cfg: {},
      logger,
      runExtractImplicitFeedback: vi.fn(async (opts: { onProgress?: (p: unknown) => void }) => {
        opts.onProgress?.({
          stage: "scan-sessions",
          sessionsDiscovered: 20,
          sessionsVisited: 5,
          sessionsProcessed: 4,
          signalsExtracted: 7,
        });
        return {
          signalsExtracted: 7,
          positiveCount: 5,
          negativeCount: 2,
          trajectoriesBuilt: 0,
          sessionsScanned: 20,
          sessionsVisited: 20,
          sessionsProcessed: 20,
          sessionsSkipped: 0,
          sessionsDeferred: 0,
          backlogSessionsEstimate: 0,
        };
      }),
    } as unknown as ManageBindings;

    const runner = buildCliMaintenanceRunners(bindings).get("extract-implicit");
    expect(runner).toBeDefined();
    await runner?.();

    expect(
      logLines.some(
        (l) => l.includes("extract-implicit — progress:") && l.includes("sessions=5/20") && l.includes("processed=4"),
      ),
    ).toBe(true);
  });

  it("does not throw when no logger is available on bindings (progress logging is best-effort)", async () => {
    const bindings = {
      factsDb: { getRawDb: () => ({}) },
      cfg: {},
      runEntityEnrichment: vi.fn(async (opts: { onProgress?: (p: unknown) => void }) => {
        opts.onProgress?.({ processed: 1, total: 1, factsEnriched: 0, mentions: 0, accepted: 0, rejected: 0 });
        return { processed: 1, factsEnriched: 0, llmFailures: 0, stopReason: "completed" };
      }),
    } as unknown as ManageBindings;

    const runner = buildCliMaintenanceRunners(bindings).get("enrich-entities");
    await expect(runner?.()).resolves.not.toThrow();
  });
});
