/**
 * Wiki Dream Ingester — reads dream cycle artifacts and optionally memory-wiki
 * bridge outputs, extracting novel findings and storing them as facts.
 *
 * Designed to run as an optional follow-up step after the dream cycle completes.
 * Idempotent: tracks which dream cycle runs have already been ingested via a
 * sentinel fact (`entity: "system", key: "dream-ingested-run:<runId>"`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { MemoryCategory } from "../types/memory.js";
import { pluginLogger } from "../utils/logger.js";

export interface DreamIngesterContext {
  factsDb: FactsDB;
  dreamCycleLogDir: string;
  maxRunsToProcess?: number;
}

export interface DreamIngesterResult {
  runsProcessed: number;
  runsSkipped: number;
  findingsIngested: number;
  errors: string[];
}

const INGEST_SENTINEL_ENTITY = "system";
const INGEST_SENTINEL_KEY_PREFIX = "dream-ingested-run:";
const MAX_RUNS_DEFAULT = 3;

export async function ingestDreamFindings(ctx: DreamIngesterContext): Promise<DreamIngesterResult> {
  const result: DreamIngesterResult = {
    runsProcessed: 0,
    runsSkipped: 0,
    findingsIngested: 0,
    errors: [],
  };

  if (!existsSync(ctx.dreamCycleLogDir)) return result;

  try {
    const entries = readdirSync(ctx.dreamCycleLogDir, { withFileTypes: true });
    const runDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse()
      .slice(0, ctx.maxRunsToProcess ?? MAX_RUNS_DEFAULT);

    for (const runDir of runDirs) {
      const runId = runDir;
      if (isRunAlreadyIngested(ctx.factsDb, runId)) {
        result.runsSkipped++;
        continue;
      }

      try {
        const findings = extractFindingsFromRun(join(ctx.dreamCycleLogDir, runDir));
        for (const finding of findings) {
          try {
            ctx.factsDb.store({
              text: finding.text,
              category: finding.category as MemoryCategory,
              importance: finding.importance,
              source: `dream-cycle:${runId}`,
              entity: finding.entity,
              key: finding.key,
              confidence: 0.7,
              tags: ["dream-finding", `run:${runId}`],
            });
            result.findingsIngested++;
          } catch (err) {
            result.errors.push(`Failed to store finding: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        markRunAsIngested(ctx.factsDb, runId);
        result.runsProcessed++;
      } catch (err) {
        result.errors.push(`Failed to process run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    result.errors.push(`Failed to read dream cycle log dir: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (result.findingsIngested > 0) {
    pluginLogger.info(
      `memory-hybrid: dream ingester — processed ${result.runsProcessed} run(s), ingested ${result.findingsIngested} finding(s)`,
    );
  }

  return result;
}

type Finding = {
  text: string;
  category: string;
  importance: number;
  entity?: string | null;
  key?: string | null;
};

function isRunAlreadyIngested(factsDb: FactsDB, runId: string): boolean {
  const results = factsDb.lookup(INGEST_SENTINEL_ENTITY, `${INGEST_SENTINEL_KEY_PREFIX}${runId}`);
  return results.length > 0;
}

function markRunAsIngested(factsDb: FactsDB, runId: string): void {
  factsDb.store({
    text: `Dream cycle run ${runId} findings ingested`,
    category: "meta" as MemoryCategory,
    importance: 0.1,
    source: "dream-ingester",
    entity: INGEST_SENTINEL_ENTITY,
    key: `${INGEST_SENTINEL_KEY_PREFIX}${runId}`,
    value: new Date().toISOString(),
    confidence: 1.0,
    tags: ["dream-ingester-sentinel"],
  });
}

function extractFindingsFromRun(runDirPath: string): Finding[] {
  const findings: Finding[] = [];

  try {
    const files = readdirSync(runDirPath)
      .filter((f) => f.endsWith(".json"))
      .sort();

    for (const file of files) {
      try {
        const raw = readFileSync(join(runDirPath, file), "utf-8");
        const artifact = JSON.parse(raw) as Record<string, unknown>;

        const stage = typeof artifact.stage === "string" ? artifact.stage.toLowerCase() : "";

        if (stage.includes("reflect") || stage.includes("pattern")) {
          const patterns = extractPatterns(artifact);
          findings.push(...patterns);
        }

        if (stage.includes("consolidat")) {
          const consolidated = extractConsolidatedFindings(artifact);
          findings.push(...consolidated);
        }

        if (stage.includes("digest") || stage.includes("summary")) {
          const digest = extractDigestFindings(artifact);
          findings.push(...digest);
        }
      } catch {
        // Skip unreadable artifact files
      }
    }
  } catch {
    // Run directory may not exist or be unreadable
  }

  return findings;
}

function extractPatterns(artifact: Record<string, unknown>): Finding[] {
  const findings: Finding[] = [];

  const patterns = artifact.patterns ?? artifact.patternsFound;
  if (Array.isArray(patterns)) {
    for (const p of patterns) {
      const text = typeof p === "string" ? p : typeof (p as Record<string, unknown>)?.text === "string" ? (p as Record<string, unknown>).text as string : null;
      if (text && text.length > 10) {
        findings.push({
          text: `Pattern discovered: ${text}`,
          category: "meta",
          importance: 0.6,
          entity: "behavioral-pattern",
        });
      }
    }
  }

  return findings;
}

function extractConsolidatedFindings(artifact: Record<string, unknown>): Finding[] {
  const findings: Finding[] = [];

  const created = artifact.factsCreated;
  if (typeof created === "number" && created > 0) {
    findings.push({
      text: `Dream cycle consolidated ${created} event(s) into durable facts`,
      category: "meta",
      importance: 0.4,
      entity: "dream-cycle",
      key: "consolidation-summary",
    });
  }

  return findings;
}

function extractDigestFindings(artifact: Record<string, unknown>): Finding[] {
  const findings: Finding[] = [];

  const summary = artifact.digestSummary ?? artifact.summary;
  if (typeof summary === "string" && summary.length > 20) {
    findings.push({
      text: summary,
      category: "meta",
      importance: 0.5,
      entity: "dream-cycle",
      key: "digest-summary",
    });
  }

  return findings;
}
