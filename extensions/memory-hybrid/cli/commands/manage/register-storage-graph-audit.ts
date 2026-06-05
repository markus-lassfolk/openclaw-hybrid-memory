/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { isValidCategory } from "../../../config.js";
import { buildAuditFailureArtifact, buildAuditHealthExitInfo } from "../../../services/audit-health-exit-info.js";
import { listDumpTypeAliases, runSqliteTableDump } from "../../../services/cli-sql-dump.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { repairEventHubs } from "../../../services/event-hub-repair.js";
import { hasAnyScopeFilter } from "../../../backends/scope-filter-sql.js";
import { getEnv } from "../../../utils/env-manager.js";
import { atomicWriteFile } from "../../../utils/atomic-write.js";
import { nowIso, formatTimestampUtcFromMs } from "../../../utils/dates.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";
import {
  buildAuditHealthReport,
  collectExportBundleFiles,
  defaultReembedVectorlessMetricsPath,
  printAuditHealthMarkdown,
  readReembedVectorlessMetrics,
  validateSyncEnvelope,
} from "./storage-stats-helpers.js";

const LEGACY_CATEGORY_REMAP_POLICY: Readonly<Record<string, string>> = {
  forge_busy: "forge",
  forge_dispatch: "forge",
  forge_ops: "forge",
  episode: "ops_summary",
};

export function registerManageStorageGraphAudit(mem: Chainable, b: ManageBindings): void {
  const {
    factsDb,
    vectorDb,
    aliasDb,
    versionInfo,
    embeddings,
    mergeResults: merge,
    getMemoryCategories,
    cfg,
    runCompaction,
    tieringEnabled,
    ctx,
    listCommands,
    auditStore,
    runExport,
  } = b;

  const graph = mem.command("graph").description("Graph repair and audit utilities");
  graph
    .command("repair")
    .description("Repair historical graph pathologies")
    .option("--collapse-event-hubs", "Collapse legacy dream-cycle/session heartbeat DERIVED_FROM mega-hubs")
    .option("--apply", "Apply mutations. Omit for dry-run")
    .option("--threshold <n>", "Outbound DERIVED_FROM threshold for hub candidates", "500")
    .option("--json", "Emit JSON instead of markdown")
    .action(
      withExit(async (opts?: { collapseEventHubs?: boolean; apply?: boolean; threshold?: string; json?: boolean }) => {
        if (!opts?.collapseEventHubs) {
          console.error("error: graph repair currently requires --collapse-event-hubs");
          process.exitCode = 1;
          return;
        }
        const threshold = Number.parseInt(opts.threshold ?? "500", 10);
        if (!Number.isFinite(threshold) || threshold < 1) {
          console.error("error: --threshold must be a positive integer");
          process.exitCode = 1;
          return;
        }
        const raw = factsDb.getRawDb?.();
        if (!raw) {
          console.error("error: raw SQLite handle is unavailable");
          process.exitCode = 1;
          return;
        }
        const report = repairEventHubs(raw, { threshold, apply: opts.apply === true });
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(`# Graph repair: collapse event hubs (${report.apply ? "apply" : "dry-run"})`);
        console.log("");
        console.log(`Threshold: ${report.threshold}`);
        console.log(`Candidates: ${report.candidates.length}`);
        console.log(`Before max outbound DERIVED_FROM: ${report.before.maxOutboundDerivedFrom}`);
        console.log(`Before facts over threshold: ${report.before.overThresholdFacts}`);
        console.log(`Before link types: ${JSON.stringify(report.before.linkTypes)}`);
        if (report.candidates.length > 0) {
          console.log("");
          console.log("Candidate examples:");
          for (const candidate of report.candidates.slice(0, 10)) {
            console.log(
              `- ${candidate.factId}: ${candidate.outboundDerivedFrom} DERIVED_FROM (${candidate.reason}) ${candidate.textPreview}`,
            );
          }
        }
        if (!report.apply) {
          console.log("");
          console.log(
            "Dry-run only. Re-run with --apply to migrate provenance_json and delete eligible DERIVED_FROM links.",
          );
          return;
        }
        console.log("");
        console.log(`Migrated facts: ${report.migratedFacts}`);
        console.log(`Deleted DERIVED_FROM links: ${report.deletedLinks}`);
        console.log(`After max outbound DERIVED_FROM: ${report.after?.maxOutboundDerivedFrom ?? 0}`);
        console.log(`After facts over threshold: ${report.after?.overThresholdFacts ?? 0}`);
        console.log(`After link types: ${JSON.stringify(report.after?.linkTypes ?? [])}`);
      }),
    );

  const runAuditHealth = async (
    opts?: { json?: boolean; format?: string; strict?: boolean; timeoutMs?: string; output?: string },
    cmd?: CommanderOptsParent,
  ) => {
    const parsedTimeoutMs = Number.parseInt(String(opts?.timeoutMs ?? "30000"), 10);
    const timeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0 ? parsedTimeoutMs : 30000;
    const startedAtMs = Date.now();
    const deadlineMs = startedAtMs + timeoutMs;
    const wantsJson = opts?.json === true || String(opts?.format ?? "").toLowerCase() === "json";
    const outputPath = opts?.output ?? null;
    let lanceBytes: number | null = null;
    const preReportErrors: Array<{ section: string; message: string }> = [];
    const preReportWarnings: string[] = [];
    // #1809: warn in audit-health when personaProposals is enabled but scopeFilter is not configured.
    if (cfg.personaProposals.enabled && !hasAnyScopeFilter(cfg.autoRecall?.scopeFilter)) {
      preReportWarnings.push(
        `personaProposals is enabled but autoRecall.scopeFilter is not set; generate-proposals will include facts from all scopes. Set autoRecall.scopeFilter (e.g. agentId/userId) to restrict proposals to a specific user/agent and avoid cross-scope contamination. For multi-agent hosts, also consider setting personaProposals.requireScopeFilter: true to hard-fail when scopeFilter is absent.`,
      );
    }
    // #1832: warn when credentials vault is plaintext but an encryption key is configured.
    let credentialsStatus = null;
    try {
      credentialsStatus = b.runVaultStatus?.() ?? null;
    } catch (err) {
      preReportErrors.push({
        section: "credentials.vaultStatus",
        message: err instanceof Error ? err.message : String(err),
      });
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "audit-health-vault-status",
        severity: "info",
        subsystem: "cli",
      });
    }
    if (credentialsStatus?.migrationRequired) {
      preReportWarnings.push(
        `Credentials vault is plaintext (kdf_version=${credentialsStatus.kdfVersion}) but an encryption key is configured. ` +
          `Encrypt the vault: run \`openclaw hybrid-mem credentials encrypt-vault --backup --verify --yes\` (see docs/CREDENTIALS.md).`,
      );
    }
    const withTimeout = async <T>(promise: Promise<T>, section: string): Promise<T | undefined> => {
      const remainingMs = Math.max(1, deadlineMs - Date.now());
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => {
              preReportErrors.push({
                section,
                message: `Timed out after ${timeoutMs}ms overall audit-health budget; section omitted`,
              });
              resolve(undefined);
            }, remainingMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    /**
     * Write JSON payload to --output path atomically (tmp + rename) or to stdout when --json.
     * Atomic tmp+rename avoids leaving a 0-byte destination file if the process is killed mid-write
     * (#1823).
     */
    const emitJsonArtifact = (payload: unknown): void => {
      const json = JSON.stringify(payload, null, 2);
      if (outputPath) {
        atomicWriteFile(outputPath, json);
      } else {
        writeFileSync(process.stdout.fd, `${json}\n`, "utf-8");
      }
    };

    try {
      try {
        const sizes = await withTimeout(Promise.resolve(ctx.richStatsExtras?.getStorageSizes()), "storage.lanceBytes");
        if (sizes?.lanceBytesTimedOut) {
          preReportErrors.push({
            section: "storage.lanceBytes",
            message: "LanceDB directory size probe timed out (du terminated after 5s); storage.lanceBytes omitted",
          });
        } else if (sizes && typeof sizes.lanceBytes === "number") {
          lanceBytes = sizes.lanceBytes;
        }
      } catch (err) {
        preReportErrors.push({
          section: "storage.lanceBytes",
          message: err instanceof Error ? err.message : String(err),
        });
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "audit-health-lance-bytes",
          severity: "info",
          subsystem: "cli",
        });
      }
      const lastReembedProgress = ctx.resolvedSqlitePath
        ? readReembedVectorlessMetrics(defaultReembedVectorlessMetricsPath(ctx.resolvedSqlitePath))
        : null;
      const report = buildAuditHealthReport(
        factsDb,
        getMemoryCategories,
        cfg.entityExtraction.stopWords,
        cfg.graph.hubDegreeCap,
        {
          lanceBytes,
          preReportErrors,
          preReportWarnings,
          timeoutMs,
          startedAtMs,
          deadlineMs,
          credentialsStatus: credentialsStatus
            ? {
                encryptedAtRest: credentialsStatus.encryptedAtRest,
                kdfVersion: credentialsStatus.kdfVersion,
                entryCount: credentialsStatus.entryCount,
                migrationRequired: credentialsStatus.migrationRequired,
              }
            : null,
          degradedState:
            typeof (vectorDb as { getDegradedState?: unknown }).getDegradedState === "function"
              ? (
                  vectorDb as {
                    getDegradedState: () => { active: boolean; reason: string | null; sinceEpochMs: number | null };
                  }
                ).getDegradedState()
              : { active: false, reason: null },
          lastReembedProgress,
        },
      );
      const strict = opts?.strict === true;
      const exitInfo = buildAuditHealthExitInfo({
        strict,
        warningCount: report.warningCount,
        errorCount: report.errorCount,
        ok: report.ok,
        status: report.status,
      });
      const verbose = readHybridMemVerbose(cmd) || getEnv("HYBRID_MEMORY_VERBOSE") === "1";
      if (wantsJson || outputPath) {
        emitJsonArtifact({
          ...report,
          exitCode: exitInfo.exitCode,
          exitReason: exitInfo.exitReason,
          strictFailureReason: exitInfo.strictFailureReason,
        });
      } else {
        printAuditHealthMarkdown(report);
      }
      if (strict && exitInfo.exitCode !== 0) {
        process.exitCode = exitInfo.exitCode;
        if (verbose) {
          if (exitInfo.exitReason === "strict_warnings") {
            console.error(
              `audit health: strict mode failed because ${report.warningCount} warning(s) were present; errors=${report.errorCount}`,
            );
          } else if (exitInfo.exitReason === "strict_errors") {
            console.error(
              `audit health: strict mode failed because ${report.errorCount} error(s) were present; warnings=${report.warningCount}`,
            );
          } else {
            console.error(
              `audit health: strict mode failed (${exitInfo.exitReason}); warnings=${report.warningCount} errors=${report.errorCount}`,
            );
          }
        }
      }
    } catch (err) {
      // #1823: on unhandled error emit a structured failure artifact so downstream consumers
      // (final-audit.json etc.) never receive a 0-byte file. The failure artifact is
      // schema-consistent so `jq` pipelines can detect the failure without special-casing.
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "audit-health",
        severity: "error",
        subsystem: "cli",
      });
      if (wantsJson || outputPath) {
        try {
          const strict = opts?.strict === true;
          emitJsonArtifact(
            buildAuditFailureArtifact(err, Date.now() - startedAtMs, strict, preReportErrors, preReportWarnings),
          );
        } catch (emitErr) {
          // Last-resort: if emitJsonArtifact itself fails (e.g. disk full or stdout closed),
          // emit a minimal diagnostic to stderr so the operator has something to act on.
          console.error(
            `audit health: failed to write failure artifact: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
          );
        }
        process.exitCode = 2;
        return;
      }
      throw err;
    }
  };

  mem
    .command("audit-health")
    .description("One-shot non-destructive hybrid-memory health report (JSON or markdown)")
    .option("--json", "Emit versioned JSON instead of markdown")
    .option("--format <format>", "Output format: markdown or json", "markdown")
    .option("--timeout-ms <n>", "Overall audit budget in milliseconds (default: 30000)", "30000")
    .option(
      "--strict",
      "Exit 2 when warnings/errors or partial/failed status are present. JSON includes exitCode/exitReason/strictFailureReason.",
    )
    .option(
      "--output <path>",
      "Write JSON artifact atomically to this path (tmp+rename) instead of stdout. Always written even on strict failure (#1823).",
    )
    .action(withExit(runAuditHealth));

  const audit = mem.command("audit").description("Audit hybrid-memory health and maintenance state");
  audit
    .command("health")
    .description("One-shot non-destructive hybrid-memory health report (JSON or markdown)")
    .option("--json", "Emit versioned JSON instead of markdown")
    .option("--format <format>", "Output format: markdown or json", "markdown")
    .option("--timeout-ms <n>", "Overall audit budget in milliseconds (default: 30000)", "30000")
    .option(
      "--strict",
      "Exit 2 when warnings/errors or partial/failed status are present. JSON includes exitCode/exitReason/strictFailureReason.",
    )
    .option(
      "--output <path>",
      "Write JSON artifact atomically to this path (tmp+rename) instead of stdout. Always written even on strict failure (#1823).",
    )
    .action(withExit(runAuditHealth));

  audit
    .command("log")
    .description("Cross-agent audit trail (Issue #790): query logged memory operations")
    .option("--hours <n>", "Look back window in hours", "24")
    .option("--agent <id>", "Filter by agent id")
    .option("--outcome <o>", "Filter: success, partial, or failed")
    .option("--target <t>", "Substring match on target field")
    .option("--format <f>", "Output: lines, summary, or timeline", "lines")
    .action(
      withExit(
        async (opts?: { hours?: string; agent?: string; outcome?: string; target?: string; format?: string }) => {
          if (!auditStore) {
            console.error("Audit store is not available (e.g. in-memory tests or missing DB path).");
            process.exitCode = 1;
            return;
          }
          const hours = Math.max(1, Math.min(720, Number.parseInt(String(opts?.hours ?? "24"), 10) || 24));
          const sinceMs = Date.now() - hours * 3600 * 1000;
          const outcome =
            opts?.outcome === "success" || opts?.outcome === "partial" || opts?.outcome === "failed"
              ? opts.outcome
              : undefined;
          const fmt = (opts?.format ?? "lines").toLowerCase();
          const rows = auditStore.query({
            sinceMs,
            agentId: opts?.agent?.trim() || undefined,
            outcome,
            targetContains: opts?.target?.trim() || undefined,
            limit: fmt === "summary" ? 5000 : 500,
          });
          if (fmt === "summary") {
            let total = 0;
            const byOutcome: Record<string, number> = { success: 0, partial: 0, failed: 0 };
            const byAgent: Record<string, number> = {};
            for (const r of rows) {
              total++;
              byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
              byAgent[r.agentId] = (byAgent[r.agentId] ?? 0) + 1;
            }
            console.log(`Audit (last ${hours}h, filtered): total=${total}`);
            console.log(`  success=${byOutcome.success} partial=${byOutcome.partial} failed=${byOutcome.failed}`);
            for (const [a, c] of Object.entries(byAgent).sort((x, y) => y[1] - x[1])) {
              console.log(`  ${a}: ${c}`);
            }
            return;
          }
          if (fmt === "timeline") {
            const byHour = new Map<string, number>();
            for (const r of rows) {
              const d = new Date(r.timestamp);
              const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:00`;
              byHour.set(key, (byHour.get(key) ?? 0) + 1);
            }
            const keys = [...byHour.keys()].sort();
            for (const k of keys) {
              console.log(`${k}  ${"█".repeat(Math.min(40, byHour.get(k) ?? 0))} (${byHour.get(k)})`);
            }
            return;
          }
          for (const r of rows) {
            const ts = formatTimestampUtcFromMs(r.timestamp).replace("T", " ").slice(0, 19);
            const dur = r.durationMs != null ? ` [${r.durationMs}ms]` : "";
            const tgt = r.target ? ` ${r.target}` : "";
            const err = r.error ? ` err=${r.error.slice(0, 80)}` : "";
            console.log(`${ts} ${r.agentId} ${r.action} ${r.outcome}${tgt}${dur}${err}`);
          }
          if (rows.length === 0) {
            console.log("(no events in window)");
          }
        },
      ),
    );

  audit
    .command("session")
    .description(
      "Unified session observability: timeline of capture, recall, injection, suppressions, and why-recalled",
    )
    .option("--session-id <id>", "Session id to inspect")
    .option("--agent <id>", "Optional agent id filter")
    .option("--limit <n>", "Max timeline entries per section (default 50, max 200)", "50")
    .option("--format <f>", "Output: summary (default), timeline, or json", "summary")
    .action(
      withExit(async (opts?: { sessionId?: string; agent?: string; limit?: string; format?: string }) => {
        const limitRaw = Number.parseInt(String(opts?.limit ?? "50"), 10);
        const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));
        const format = String(opts?.format ?? "summary")
          .trim()
          .toLowerCase();
        const sessionId = opts?.sessionId?.trim() || undefined;
        const agentId = opts?.agent?.trim() || undefined;
        const { buildSessionObservabilityReport } = await import("../../../services/session-observability.js");
        const report = await buildSessionObservabilityReport({
          factsDb,
          eventLog: null,
          narrativesDb: null,
          auditStore: auditStore ?? null,
          sessionId,
          agentId,
          limit,
        });

        if (format === "json") {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        if (format === "timeline") {
          console.log(
            `Session observability timeline (${report.sessionId ?? "current"}, entries=${report.timeline.length})`,
          );
          for (const entry of report.timeline) {
            const outcome = entry.outcome ? ` [${entry.outcome}]` : "";
            const score = entry.score != null ? ` score=${entry.score.toFixed(3)}` : "";
            console.log(`${entry.timestamp} ${entry.kind}${outcome}: ${entry.label} — ${entry.description}${score}`);
          }
          if (report.timeline.length === 0) {
            console.log("(no timeline entries for the requested scope)");
          }
          return;
        }

        console.log(`Session: ${report.sessionId ?? "current"}${report.agentId ? `  agent=${report.agentId}` : ""}`);
        if (report.windowStart || report.windowEnd) {
          console.log(`Window: ${report.windowStart ?? "?"} → ${report.windowEnd ?? "?"}`);
        }
        console.log(report.summary);
        console.log("");
        console.log("Capture");
        console.log(
          `  stored=${report.capture.factsStored} updated=${report.capture.factsUpdated} duplicatesSuppressed=${report.capture.duplicatesSuppressed} noopSkipped=${report.capture.noopSkipped} errors=${report.capture.errorsEncountered}`,
        );
        console.log("Recall");
        console.log(
          `  candidates=${report.recall.candidatesFound} injected=${report.recall.injectedCount} omitted=${report.recall.omittedCount}`,
        );
        if (report.recall.strategies.length > 0) {
          console.log(`  strategies=${report.recall.strategies.join(", ")}`);
        }
        if (report.recall.directiveMatches.length > 0) {
          console.log(`  directives=${report.recall.directiveMatches.slice(0, 5).join(" | ")}`);
        }
        if (report.recall.suppressionReasons.length > 0) {
          console.log(`  suppressionReasons=${report.recall.suppressionReasons.slice(0, 3).join(" | ")}`);
        }
        console.log("Injection");
        console.log(
          `  blocks=${report.injection.blocksInjected} tokens≈${report.injection.totalTokensEstimate} budget=${report.injection.budgetTokens} used≈${Math.round(report.injection.budgetUsedFraction * 100)}%`,
        );
        if (report.suppressions.length > 0) {
          console.log("Suppressions");
          for (const s of report.suppressions.slice(0, 10)) {
            console.log(`  ${s.timestamp} [${s.outcome}] ${s.reason}${s.detail ? ` — ${s.detail}` : ""}`);
          }
        }
      }),
    );

  mem
    .command("telemetry-summary")
    .description("Local privacy-safe telemetry summary (config state + local audit volume; no network calls)")
    .option("--hours <n>", "Look-back window in hours for local audit volume (default 24)", "24")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { hours?: string; json?: boolean }) => {
        const hoursRaw = Number.parseInt(String(opts?.hours ?? "24"), 10);
        const hours = Math.max(1, Math.min(720, Number.isFinite(hoursRaw) ? hoursRaw : 24));
        const sinceMs = Date.now() - hours * 3600 * 1000;
        const rows = auditStore ? auditStore.query({ sinceMs, limit: 5000 }) : [];
        const byOutcome: Record<string, number> = { success: 0, partial: 0, failed: 0 };
        const byAction: Record<string, number> = {};
        for (const row of rows) {
          byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
          byAction[row.action] = (byAction[row.action] ?? 0) + 1;
        }
        const topActions = Object.entries(byAction)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([action, count]) => ({ action, count }));
        const summary = {
          schemaVersion: 1,
          generatedAt: nowIso(),
          localFirst: true,
          reporting: {
            enabled: cfg.errorReporting.enabled === true,
            consent: cfg.errorReporting.consent === true,
            mode: cfg.errorReporting.mode,
            destination: cfg.errorReporting.mode === "self-hosted" ? "self-hosted" : "community",
          },
          localAuditWindow: {
            hours,
            totalEvents: rows.length,
            byOutcome,
            topActions,
          },
          notes: [
            "This command only reads local stores.",
            "No telemetry is sent by this command.",
            "Set errorReporting.enabled=false or errorReporting.consent=false to fully opt out.",
          ],
        };
        if (opts?.json) {
          console.log(JSON.stringify(summary, null, 2));
          return;
        }
        console.log("Telemetry summary (local, privacy-safe)");
        console.log(
          `Reporting: enabled=${summary.reporting.enabled} consent=${summary.reporting.consent} mode=${summary.reporting.mode} destination=${summary.reporting.destination}`,
        );
        console.log(
          `Local audit window (${hours}h): total=${summary.localAuditWindow.totalEvents} success=${summary.localAuditWindow.byOutcome.success} partial=${summary.localAuditWindow.byOutcome.partial} failed=${summary.localAuditWindow.byOutcome.failed}`,
        );
        if (topActions.length > 0) {
          console.log("Top local actions:");
          for (const item of topActions) {
            console.log(`  - ${item.action}: ${item.count}`);
          }
        }
      }),
    );

  mem
    .command("sync-export")
    .description("Create an encrypted replication bundle from local memory export (AES-256-GCM)")
    .requiredOption("--out <path>", "Output encrypted bundle path (.hm-sync)")
    .option(
      "--passphrase-env <name>",
      "Environment variable that contains encryption passphrase (default HYBRID_MEM_SYNC_PASSPHRASE)",
      "HYBRID_MEM_SYNC_PASSPHRASE",
    )
    .option("--sources <csv>", "Optional comma-separated sources filter for export")
    .action(
      withExit(async (opts?: { out?: string; passphraseEnv?: string; sources?: string }) => {
        const outPath = String(opts?.out ?? "").trim();
        if (!outPath) {
          console.error("error: --out is required");
          process.exitCode = 1;
          return;
        }
        const passphraseEnv = String(opts?.passphraseEnv ?? "HYBRID_MEM_SYNC_PASSPHRASE").trim();
        const passphrase = getEnv(passphraseEnv);
        if (!passphrase || passphrase.length < 20) {
          console.error("error: set a strong sync passphrase (>=20 chars) in the configured environment variable");
          process.exitCode = 1;
          return;
        }
        const tmpDir = mkdtempSync(join(tmpdir(), "hybrid-mem-sync-"));
        const tmpExportDir = join(tmpDir, "export");
        const sources = opts?.sources
          ?.split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        try {
          const exportResult = await runExport({ outputPath: tmpExportDir, excludeCredentials: true, sources });
          const plaintext = JSON.stringify(
            {
              schemaVersion: 1,
              type: "hybrid-memory-sync-export",
              exportedAt: nowIso(),
              metadata: {
                factsExported: exportResult.factsExported,
                proceduresExported: exportResult.proceduresExported,
                filesWritten: exportResult.filesWritten,
              },
              files: collectExportBundleFiles(exportResult.outputPath),
            },
            null,
            2,
          );

          const salt = randomBytes(16);
          const iv = randomBytes(12);
          const iterations = 600_000;
          const key = pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
          const cipher = createCipheriv("aes-256-gcm", key, iv);
          const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
          const tag = cipher.getAuthTag();
          const envelope = {
            schemaVersion: 1,
            type: "hybrid-memory-sync-bundle",
            encryptedAt: nowIso(),
            alg: "aes-256-gcm",
            kdf: "pbkdf2-sha256",
            iterations,
            salt: salt.toString("base64"),
            iv: iv.toString("base64"),
            tag: tag.toString("base64"),
            ciphertext: ciphertext.toString("base64"),
            metadata: {
              factsExported: exportResult.factsExported,
              proceduresExported: exportResult.proceduresExported,
              filesWritten: exportResult.filesWritten,
            },
          };
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, JSON.stringify(envelope, null, 2), "utf-8");
          console.log(`Encrypted sync bundle written to ${outPath}`);
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
    );

  mem
    .command("sync-import")
    .description("Decrypt an encrypted replication bundle into JSON export payload for restore/import workflows")
    .requiredOption("--in <path>", "Encrypted bundle path (.hm-sync)")
    .requiredOption("--out <path>", "Destination decrypted JSON path")
    .option(
      "--passphrase-env <name>",
      "Environment variable that contains decryption passphrase (default HYBRID_MEM_SYNC_PASSPHRASE)",
      "HYBRID_MEM_SYNC_PASSPHRASE",
    )
    .action(
      withExit(async (opts?: { in?: string; out?: string; passphraseEnv?: string }) => {
        const inPath = String(opts?.in ?? "").trim();
        const outPath = String(opts?.out ?? "").trim();
        if (!inPath || !outPath) {
          console.error("error: --in and --out are required");
          process.exitCode = 1;
          return;
        }
        const passphraseEnv = String(opts?.passphraseEnv ?? "HYBRID_MEM_SYNC_PASSPHRASE").trim();
        const passphrase = getEnv(passphraseEnv);
        if (!passphrase) {
          console.error(
            "error: set the sync passphrase in the configured environment variable before running sync-import",
          );
          process.exitCode = 1;
          return;
        }
        let envelope;
        try {
          envelope = validateSyncEnvelope(JSON.parse(readFileSync(inPath, "utf-8")));
        } catch (err) {
          console.error(`error: invalid sync bundle ${inPath}: ${String(err)}`);
          process.exitCode = 1;
          return;
        }
        const key = pbkdf2Sync(passphrase, envelope.salt, envelope.iterations, 32, "sha256");
        const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv);
        decipher.setAuthTag(envelope.tag);
        const plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf-8");
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, plaintext, "utf-8");
        console.log(`Decrypted sync payload written to ${outPath}`);
      }),
    );

  mem
    .command("addons")
    .description("Inspect modular add-on domains for the hybrid-memory ecosystem")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const domains = [
          {
            id: "analysis",
            status: "planned",
            summary: "Long-window analytics and heavy maintenance intelligence",
          },
          {
            id: "learning",
            status: "planned",
            summary: "Optional advanced procedure/workflow learning expansions",
          },
          {
            id: "observability",
            status: "planned",
            summary: "Extended dashboards and reporting integrations",
          },
          {
            id: "self-extension",
            status: "planned",
            summary: "Proposal/self-evolution utilities beyond core defaults",
          },
        ];
        if (opts?.json) {
          console.log(JSON.stringify({ schemaVersion: 1, domains }, null, 2));
          return;
        }
        console.log("Hybrid Memory add-on ecosystem domains:");
        for (const domain of domains) {
          console.log(`- ${domain.id} (${domain.status}): ${domain.summary}`);
        }
      }),
    );

  const categoriesCommand = mem
    .command("categories")
    .description("Inspect and repair category drift")
    .action(
      withExit(async () => {
        try {
          const cats = factsDb.uniqueMemoryCategories();
          console.log(`Categories in memory (${cats.length}):`);
          for (const c of cats) {
            console.log(`  - ${c}`);
          }
          console.log("");
          console.log("Tip: run 'openclaw hybrid-mem categories audit' to compare configured vs in-memory categories.");
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "categories",
          });
          throw err;
        }
      }),
    );

  categoriesCommand
    .command("audit")
    .description(
      "Show configured vs in-memory category drift with counts; samples show text previews for unknown labels",
    )
    .option("--json", "Emit JSON")
    .option("--examples <n>", "Sample facts per category (text preview + id)", "5")
    .option("--show-all-samples", "Include sample previews for configured categories too (default: unknown only)")
    .action(
      withExit(async (opts?: { json?: boolean; examples?: string; showAllSamples?: boolean }) => {
        const examples = Number.parseInt(opts?.examples ?? "5", 10);
        if (!Number.isFinite(examples) || examples < 0 || examples > 50) {
          console.error("error: --examples must be an integer from 0 to 50");
          process.exitCode = 1;
          return;
        }
        const report = factsDb.auditCategories(getMemoryCategories(), examples);
        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        const unknownNames = new Set(report.unknown.map((u) => u.category));
        console.log(`Categories configured (${report.configured.length}): ${report.configured.join(", ")}`);
        console.log(`Categories in memory (${report.inMemory.length}):`);
        for (const row of report.inMemory) {
          const marker = unknownNames.has(row.category) ? " [not in config]" : "";
          console.log(`  - ${row.category}: ${row.count}${marker}`);
          const showSamples =
            examples > 0 &&
            row.examples.length > 0 &&
            (opts?.showAllSamples === true || unknownNames.has(row.category));
          if (showSamples) {
            for (let i = 0; i < row.examples.length; i++) {
              const id = row.examples[i];
              const preview = row.examplePreviews[i] ?? "";
              console.log(`      • ${preview}`);
              console.log(`        id ${id}  →  openclaw hybrid-mem show ${id}`);
            }
          }
        }
        if (report.unknown.length > 0) {
          console.log("");
          console.log(
            `Labels in DB but not in your config (${report.unknown.length}): ${report.unknown.map((u) => u.category).join(", ")}`,
          );
          const unknownCategories = new Set(report.unknown.map((u) => u.category));
          const legacyRemapCommands = Object.entries(LEGACY_CATEGORY_REMAP_POLICY)
            .filter(([from]) => unknownCategories.has(from))
            .map(([from, to]) => `openclaw hybrid-mem categories remap --from ${from} --to ${to} --apply`);
          if (legacyRemapCommands.length > 0) {
            console.log("Legacy category remap policy:");
            for (const command of legacyRemapCommands) {
              console.log(`  ${command}`);
            }
          }
          console.log(
            "Remap into a configured category (dry-run by default), e.g.: openclaw hybrid-mem categories remap --from monitoring --to fact",
          );
          console.log("Apply after review: add --apply");
        } else {
          console.log("");
          console.log("No extra labels: every in-memory category is listed in config.");
        }
        if (report.configuredOnly.length > 0) {
          console.log(`Configured categories with no active facts: ${report.configuredOnly.join(", ")}`);
        }
      }),
    );

  categoriesCommand
    .command("propose")
    .description("List `category-suggested:*` tags emitted by the auto-classifier (#1188)")
    .option("--json", "Emit JSON")
    .option("--examples <n>", "Example fact ids per suggestion", "5")
    .action(
      withExit(async (opts?: { json?: boolean; examples?: string }) => {
        const examples = Number.parseInt(opts?.examples ?? "5", 10);
        if (!Number.isFinite(examples) || examples < 0 || examples > 50) {
          console.error("error: --examples must be an integer from 0 to 50");
          process.exitCode = 1;
          return;
        }
        const proposals = factsDb.proposedCategories(examples);
        if (opts?.json) {
          console.log(JSON.stringify({ proposals }, null, 2));
          return;
        }
        if (proposals.length === 0) {
          console.log("No category-suggested:* tags found. The auto-classifier has not surfaced new labels yet.");
          return;
        }
        console.log(`Proposed categories (${proposals.length}):`);
        for (const row of proposals) {
          const examplesText = row.examples.length > 0 ? ` examples=${row.examples.join(",")}` : "";
          console.log(`  - ${row.label}: ${row.count}${examplesText}`);
        }
        console.log("");
        console.log("To promote a label, add it to plugin config `categories` or remap matching facts:");
        console.log("  openclaw hybrid-mem categories remap --from other --to <label> --apply");
      }),
    );

  categoriesCommand
    .command("remap")
    .description("Bulk-remap facts from one category to a configured category (dry-run by default)")
    .requiredOption("--from <category>", "Existing category to remap")
    .requiredOption("--to <category>", "Configured destination category")
    .option("--apply", "Apply the remap; default is dry-run")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { from?: string; to?: string; apply?: boolean; json?: boolean }) => {
        const from = (opts?.from ?? "").trim();
        const to = (opts?.to ?? "").trim();
        if (!from || !to) {
          console.error("error: --from and --to are required");
          process.exitCode = 1;
          return;
        }
        if (from === to) {
          console.error("error: --from and --to must differ");
          process.exitCode = 1;
          return;
        }
        if (!isValidCategory(to)) {
          console.error(
            `error: --to must be a configured category. Valid categories: ${getMemoryCategories().join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }
        const report = factsDb.remapCategory(from, to, opts?.apply === true);
        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(`Category remap ${report.apply ? "applied" : "dry-run"}: ${report.from} -> ${report.to}`);
        console.log(`Matched facts: ${report.matched} (${report.activeMatched} active)`);
        console.log(`Changed facts: ${report.changed}`);
        if (!report.apply) {
          console.log("Dry-run only. Re-run with --apply to update facts.");
        }
      }),
    );

  mem
    .command("list")
    .description("List recent facts (default 10)")
    .option("--limit <n>", "Max results", "10")
    .option("--category <cat>", "Filter by category")
    .option("--entity <ent>", "Filter by entity")
    .option("--key <k>", "Filter by key")
    .option("--source <src>", "Filter by source")
    .option("--tier <t>", "Filter by tier (hot/warm/cold/structural)")
    .action(
      withExit(
        async (opts?: {
          limit?: string;
          category?: string;
          entity?: string;
          key?: string;
          source?: string;
          tier?: string;
        }) => {
          try {
            const limitParsed = Number.parseInt(opts?.limit ?? "10", 10);
            if (!Number.isFinite(limitParsed) || limitParsed < 1 || limitParsed > 50_000) {
              console.error("error: --limit must be an integer from 1 to 50000");
              process.exitCode = 1;
              return;
            }
            const limit = limitParsed;
            const filters = {
              category: opts?.category,
              entity: opts?.entity,
              key: opts?.key,
              source: opts?.source,
              tier: opts?.tier as "hot" | "warm" | "cold" | "structural" | undefined,
            };
            const facts = factsDb.list(limit, filters);
            console.log(`Recent facts (limit ${limit}):`);
            for (const f of facts) {
              console.log(`  [${f.id}] ${f.text} (tier=${f.tier}, category=${f.category ?? "none"})`);
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "list",
            });
            throw err;
          }
        },
      ),
    );

  mem
    .command("show <id>")
    .description(
      "Show full detail for a fact by ID. For proposals use: hybrid-mem proposals show <id> (supports --diff, --json)",
    )
    .action(
      withExit(async (id: string) => {
        if (!listCommands?.showItem) {
          const fact = factsDb.get(id);
          if (!fact) {
            console.log(`Fact not found: ${id}`);
            return;
          }
          console.log(JSON.stringify(fact, null, 2));
          return;
        }
        const item = await listCommands.showItem(id);
        if (!item) {
          console.log(`Item not found: ${id}`);
          return;
        }
        if (item.type === "proposal") {
          console.log(`Proposal ${id}. Use: openclaw hybrid-mem proposals show ${id} (--diff, --json)`);
          return;
        }
        console.log(`Type: ${item.type}`);
        console.log(JSON.stringify(item.data, null, 2));
      }),
    );

  mem
    .command("dump")
    .description(
      "Inspect SQLite table rows (read-only). Use --type fact_entity (PERSON/ORG mentions), organizations, contacts, facts, etc. See --list-types.",
    )
    .option("--type <t>", "Table alias or physical name (required unless --list-types)")
    .option("--limit <n>", "Max rows (1–5000, default 20)", "20")
    .option("--order <dir>", "Sort: last = newest first, first = oldest first", "last")
    .option("--json", "JSON array output (no text truncation)")
    .option("--list-types", "Print allowed --type values and exit")
    .action(
      withExit(
        async (opts?: { type?: string; limit?: string; order?: string; json?: boolean; listTypes?: boolean }) => {
          if (opts?.listTypes) {
            for (const t of listDumpTypeAliases()) console.log(t);
            return;
          }
          const typeRaw = opts?.type?.trim();
          if (!typeRaw) {
            console.error("error: --type is required (or use --list-types for valid names)");
            process.exitCode = 1;
            return;
          }
          const limitParsed = Number.parseInt(opts?.limit ?? "20", 10);
          if (!Number.isFinite(limitParsed) || limitParsed < 1 || limitParsed > 5000) {
            console.error("error: --limit must be an integer from 1 to 5000");
            process.exitCode = 1;
            return;
          }
          const orderRaw = (opts?.order ?? "last").toLowerCase();
          if (orderRaw !== "first" && orderRaw !== "last") {
            console.error('error: --order must be "first" or "last"');
            process.exitCode = 1;
            return;
          }
          const order = orderRaw as "first" | "last";
          try {
            const result = runSqliteTableDump(factsDb.getRawDb(), {
              type: typeRaw,
              limit: limitParsed,
              order,
              json: !!opts?.json,
            });
            if (!result.ok) {
              console.error(result.error);
              process.exitCode = 1;
              return;
            }
            if (opts?.json) {
              console.log(JSON.stringify(result.rows, null, 2));
              return;
            }
            console.log(`Table ${result.table} (${result.rows.length} row(s), order=${order}):`);
            for (let i = 0; i < result.rows.length; i++) {
              console.log(`--- ${i + 1} ---`);
              console.log(JSON.stringify(result.rows[i], null, 2));
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "dump",
            });
            throw err;
          }
        },
      ),
    );
}
