/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { LoomStore } from "../../../backends/loom-store.js";
import type { HybridMemoryConfig } from "../../../config.js";
import { formatBytes } from "../../../utils/format.js";
import {
  DEFAULT_BACKUP_RETENTION_AGE_DAYS,
  DEFAULT_BACKUP_RETENTION_COUNT,
  getBackupStatus,
  pruneBackups,
  type BackupRetentionOptions,
} from "../../backup.js";
import {
  type BackupHealthAlertPolicy,
  DEFAULT_BACKUP_HEALTH_ALERT_POLICY,
  defaultBackupStateFilePath,
  evaluateAndMaybeAlertBackupHealth,
  recordBackupOutcome,
} from "../../../services/backup-health.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import {
  createProcedurePromotionItem,
  evaluateProcedureForPromotion,
  PROCEDURE_PROMOTION_POLICY_VERSION,
  type ProcedurePromotionDuplicateCandidate,
  parseProcedurePromotionPolicy,
} from "../../../services/procedure-promotion-policy.js";
import { generateAutoSkillForProcedure } from "../../../services/procedure-skill-generator.js";
import { rankProcedureCandidates } from "../../../services/procedure-triage.js";
import {
  PROCEDURE_TRIAGE_RECOMMENDED_ACTIONS,
  type ProcedureTriageRecommendedAction,
} from "../../../types/procedure-triage-types.js";
import { formatTimestampUtc, nowIso } from "../../../utils/dates.js";
import { resolveWorkspacePath } from "../../../utils/path.js";
import { runHybridMemVersion } from "../../cmd-version.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

/** Quote a path for use in a crontab line so spaces/special chars do not break the shell. */
function shellQuotePathForCron(path: string): string {
  if (/^[\w@%+./:-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve backup retention options from config, tolerating a partial/mocked `cfg.maintenance`
 * (e.g. narrow test harnesses that only stub the bindings a given test exercises) by falling
 * back to the same defaults the config parser applies.
 */
function resolveBackupRetentionOptions(cfg: Pick<HybridMemoryConfig, "maintenance">): BackupRetentionOptions {
  return {
    retentionCount: cfg.maintenance?.backup?.retentionCount ?? DEFAULT_BACKUP_RETENTION_COUNT,
    retentionAgeDays: cfg.maintenance?.backup?.retentionAgeDays ?? DEFAULT_BACKUP_RETENTION_AGE_DAYS,
  };
}

/** Resolve the backup health alerting policy from config, with the same partial-config tolerance. */
function resolveBackupAlertPolicy(cfg: Pick<HybridMemoryConfig, "maintenance">): BackupHealthAlertPolicy {
  return cfg.maintenance?.backup?.alerting ?? DEFAULT_BACKUP_HEALTH_ALERT_POLICY;
}

/** Ranked procedure triage (#2147) persists decisions in the Loom store. */
function requireLoomStore(store: LoomStore | null | undefined): LoomStore {
  if (!store) {
    throw new Error("Ranked procedure triage requires The Loom. Set loom.enabled: true in plugin config.");
  }
  return store;
}

export function registerManageProcedureAndLifecycle(mem: Chainable, b: ManageBindings): void {
  const {
    factsDb,
    runExtractProcedures,
    runGenerateAutoSkills,
    ctx,
    cfg,
    runUpgrade,
    runUninstall,
    runBackup,
    runBackupVerify,
    resolvedSqlitePath,
    resolvedLancePath,
  } = b;

  // Procedure feedback loop CLI (#782)
  const procedureCmd = mem
    .command("procedure")
    .description("Show procedure details (versions, failures, avoidance notes)");
  procedureCmd.alias?.("procedures");
  procedureCmd
    .command("show <id>")
    .description("Show all versions and failure history for a procedure")
    .action(
      withExit(async (id: string) => {
        const proc = factsDb.getProcedureById(id);
        if (!proc) {
          console.log(`Procedure not found: ${id}`);
          return;
        }

        const versions = factsDb.getProcedureVersions(id);
        const failures = factsDb.getProcedureFailures(id);
        const totalSuccess = proc.successCount + versions.reduce((s, v) => s + v.successCount, 0);
        const totalFailure = proc.failureCount + versions.reduce((s, v) => s + v.failureCount, 0);
        const total = totalSuccess + totalFailure;
        const rate = total > 0 ? totalSuccess / total : 0;

        console.log(`Procedure: ${proc.taskPattern}`);
        console.log(`  ID:         ${proc.id}`);
        console.log(`  Type:       ${proc.procedureType}`);
        console.log(`  Confidence: ${proc.confidence?.toFixed(3) ?? "n/a"}`);
        console.log(
          `  Success:    ${proc.successCount} (procedure table) + ${versions.reduce(
            (s, v) => s + v.successCount,
            0,
          )} (versions) = ${totalSuccess}`,
        );
        console.log(
          `  Failure:   ${proc.failureCount} (procedure table) + ${versions.reduce(
            (s, v) => s + v.failureCount,
            0,
          )} (versions) = ${totalFailure}`,
        );
        console.log(`  Rate:      ${(rate * 100).toFixed(1)}%`);
        console.log(`  Outcome:   ${proc.lastOutcome ?? "unknown"}`);
        console.log(`  Last Validated: ${proc.lastValidated ? formatTimestampUtc(proc.lastValidated) : "never"}`);
        console.log(`  Last Failed:   ${proc.lastFailed ? formatTimestampUtc(proc.lastFailed) : "never"}`);

        if (proc.avoidanceNotes && proc.avoidanceNotes.length > 0) {
          console.log("\n  Avoidance notes (all versions):");
          for (const note of proc.avoidanceNotes) {
            console.log(`    - ${note}`);
          }
        }

        if (versions.length > 0) {
          console.log(`\n  Versions (${versions.length}):`);
          for (const v of versions) {
            const pct =
              v.successCount + v.failureCount > 0
                ? ` (${((v.successCount / (v.successCount + v.failureCount)) * 100).toFixed(0)}% success)`
                : "";
            console.log(`    v${v.versionNumber}: ${v.successCount} OK, ${v.failureCount} failed${pct}`);
            if (v.avoidanceNotes && v.avoidanceNotes.length > 0) {
              for (const note of v.avoidanceNotes.slice(0, 3)) {
                console.log(`      ⚠ ${note}`);
              }
            }
          }
        }

        if (failures.length > 0) {
          console.log(`\n  Recent failures (${failures.length} total):`);
          for (const f of failures.slice(0, 10)) {
            const when = formatTimestampUtc(f.timestamp);
            const step = f.failedAtStep !== null ? ` step ${f.failedAtStep}` : "";
            console.log(`    [${when}] v${f.versionNumber}${step}: ${f.context ?? "(no context)"}`);
          }
        } else {
          console.log("\n  No failures recorded.");
        }
      }),
    );

  procedureCmd
    .command("triage")
    .description("Triage procedures that are validated but not promoted")
    .option("--status <status>", "Filter by status: validated or all", "validated")
    .option("--not-promoted", "Only include procedures not promoted to skills")
    .option("--limit <n>", "Maximum number to show", "50")
    .option("--policy <policy>", "Procedure promotion policy: draft-only, manual, auto-safe", "draft-only")
    .option(
      "--ranked",
      "Ranked/clustered triage batch (#2147) instead of the recency-ordered legacy view: bounded, deduplicated, with existing-wrapper detection",
    )
    .option("--batch <n>", "Ranked mode: batch size (default 20)")
    .option("--cluster", "Ranked mode: cluster near-duplicate procedures (default true)")
    .option("--json", "Emit JSON")
    .action(
      withExit(
        async (opts?: {
          status?: string;
          notPromoted?: boolean;
          limit?: string;
          policy?: string;
          ranked?: boolean;
          batch?: string;
          cluster?: boolean;
          json?: boolean;
        }) => {
          if (opts?.ranked || opts?.batch !== undefined) {
            const report = rankProcedureCandidates(
              { db: factsDb.getRawDb(), loomStore: requireLoomStore(b.loomStore) },
              { batchSize: opts?.batch ? Number.parseInt(opts.batch, 10) : 20, cluster: opts?.cluster !== false },
            );
            if (opts?.json) {
              console.log(JSON.stringify(report, null, 2));
              return;
            }
            console.log(`Procedure backlog: ${report.backlog}. Recommended batch (${report.recommendedBatch.length}):`);
            for (const item of report.recommendedBatch) {
              console.log(
                `[${item.recommendedAction}] ${item.taskPattern.slice(0, 80)} (cluster ${item.clusterId}, risk ${item.risk}, count ${item.count}) — ${item.why}`,
              );
            }
            return;
          }
          const status = opts?.status === "all" ? "all" : "validated";
          const limit = Number.parseInt(opts?.limit ?? "50", 10);
          if (!Number.isFinite(limit) || limit < 1) {
            console.error("error: --limit must be a positive integer");
            process.exitCode = 1;
            return;
          }
          const report = factsDb.triageProcedures({
            status,
            notPromoted: opts?.notPromoted !== false,
            limit,
            validationThreshold: cfg.procedures.validationThreshold,
          });
          const policy = parseProcedurePromotionPolicy(opts?.policy);
          const resolvedSkillsAutoPath = resolveWorkspacePath(cfg.procedures.skillsAutoPath);
          const enrichedRows = report.rows.map((row) => {
            const proc = factsDb.getProcedureById(row.id);
            if (!proc) return row;
            const item = createProcedurePromotionItem(proc, policy);
            const evaluation = evaluateProcedureForPromotion(item, policy, {
              skillsAutoPath: resolvedSkillsAutoPath,
              validationThreshold: cfg.procedures.validationThreshold,
              contextSpecificTaskPatterns: cfg.procedures.promotionContextSpecificPatterns,
            });
            return {
              ...row,
              inputHash: item.inputHash,
              policy,
              policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
              eligible: evaluation.eligible,
              promotionDecision: evaluation.metadata.promotionDecision,
              reasons: evaluation.metadata.rejectionReasons,
              enabled: false,
              requiresHumanApproval: evaluation.metadata.requiresHumanApproval,
            };
          });
          const enrichedReport = { ...report, rows: enrichedRows };
          if (opts?.json) {
            console.log(JSON.stringify(enrichedReport, null, 2));
            return;
          }
          console.log(
            `Procedures triage: ${report.summary.total} blocked${
              report.summary.topReason ? ` by ${report.summary.topReason}` : ""
            }`,
          );
          const reasonSummary = Object.entries(report.summary.byReason)
            .filter(([, count]) => count > 0)
            .map(([reason, count]) => `${reason}=${count}`)
            .join(", ");
          if (reasonSummary) console.log(`Reasons: ${reasonSummary}`);
          if (enrichedRows.length === 0) return;
          console.log("id | title | validated_at | promotion_decision | reasons | last_recall");
          for (const row of enrichedRows as Array<
            (typeof enrichedRows)[number] & {
              promotionDecision?: string;
              reasons?: string[];
            }
          >) {
            const validated = row.validatedAt ? formatTimestampUtc(row.validatedAt) : "never";
            const lastRecall = row.lastRecall ? formatTimestampUtc(row.lastRecall) : "never";
            console.log(
              `${row.id} | ${row.title.replace(/\s+/g, " ").slice(0, 80)} | ${validated} | ${
                row.promotionDecision ?? row.promotionBlockReason
              } | ${(row.reasons ?? [row.promotionBlockReason]).join(",")} | ${lastRecall}`,
            );
          }
        },
      ),
    );

  procedureCmd
    .command("promote-candidate <clusterId>")
    .description(
      "Record a triage decision for a ranked cluster (#2147): promote_to_skill | promote_to_wrapper | file_issue | no_action",
    )
    .requiredOption("--decision <decision>", "promote_to_skill|promote_to_wrapper|file_issue|no_action")
    .option("--rationale <text>", "Why")
    .option("--dry-run", "Preview only — do not record the decision")
    .action(
      withExit(async (clusterId: string, opts?: { decision?: string; rationale?: string; dryRun?: boolean }) => {
        const store = requireLoomStore(b.loomStore);
        const decision = (opts?.decision ?? "no_action") as ProcedureTriageRecommendedAction;
        if (!PROCEDURE_TRIAGE_RECOMMENDED_ACTIONS.includes(decision)) {
          throw new Error(
            `Invalid --decision "${opts?.decision}". Expected one of: ${PROCEDURE_TRIAGE_RECOMMENDED_ACTIONS.join(", ")}.`,
          );
        }
        if (opts?.dryRun) {
          console.log(
            `Dry run: would record ${clusterId} -> ${decision}${opts?.rationale ? ` (${opts.rationale})` : ""}`,
          );
          return;
        }
        const recorded = store.recordProcedureTriageDecision({ clusterId, decision, rationale: opts?.rationale });
        console.log(`Recorded ${recorded.clusterId} -> ${recorded.decision}`);
      }),
    );

  procedureCmd
    .command("list")
    .description("List all procedures (optionally filtered by type)")
    .option("--type <type>", "Filter by type: positive, negative, or all (default: all)")
    .option("--limit <n>", "Maximum number to show (default: 20)")
    .action(
      withExit(async (opts: { type?: string; limit?: string }) => {
        // opts.limit is Commander's raw string (the `number` type above was never actually
        // true), so `(opts.limit ?? 20) * 3` relied on JS's implicit string-to-number coercion --
        // works by accident for a valid numeric string, but a non-numeric --limit (e.g. "abc")
        // coerces to NaN. NaN bound into listProcedures()'s `LIMIT ?` clause throws a SQLite
        // "datatype mismatch", which listProcedures() itself catches and swallows (logging via
        // capturePluginError only), so the CLI silently prints "Procedures (showing 0 of 0):"
        // with exit code 0 instead of surfacing the bad flag (#2067-followup).
        const limit = opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : 20;
        if (!Number.isFinite(limit) || limit < 1) {
          console.error("error: --limit must be a positive integer");
          process.exitCode = 1;
          return;
        }
        const procs = factsDb.listProcedures(limit * 3); // over-fetch then filter
        const filtered = opts.type && opts.type !== "all" ? procs.filter((p) => p.procedureType === opts.type) : procs;
        const shown = filtered.slice(0, limit);

        console.log(`Procedures (showing ${shown.length} of ${filtered.length}):`);
        for (const p of shown) {
          const rate = p.successRate !== undefined ? ` ${(p.successRate * 100).toFixed(0)}%` : "";
          const ver = p.version !== undefined ? ` v${p.version}` : "";
          console.log(
            `  [${p.id.slice(0, 8)}] ${p.procedureType.padEnd(8)} ${rate.padEnd(
              6,
            )} ${ver} "${p.taskPattern.slice(0, 60)}"`,
          );
        }
      }),
    );

  // #1191: per-id procedure promote — sister to batch `generate-auto-skills`. Idempotent: a
  // second call on a promoted procedure prints the existing skill path and exits 0.
  procedureCmd
    .command("promote <id>")
    .description("Promote a single procedure to skills/auto/<slug> (idempotent)")
    .option("--dry-run", "Print what would happen without writing files")
    .option("--force", "Skip the validationThreshold safeguard (safety gates still apply)")
    .option("--apply", "Write draft/quarantined skill artifacts")
    .option(
      "--policy <policy>",
      "Promotion policy: draft-only, manual, auto-safe (default: dry-run draft-only; non-dry-run/apply defaults to auto-safe for legacy maintenance callers)",
    )
    .option(
      "--in-run-skill-json <json>",
      'Optional JSON array of {"slug":"…","taskPattern":"…"} for same-run duplicate detection (e.g. parallel single promotes)',
    )
    .option("--json", "Emit JSON")
    .action(
      withExit(
        async (
          id: string,
          opts?: {
            dryRun?: boolean;
            force?: boolean;
            apply?: boolean;
            policy?: string;
            json?: boolean;
            inRunSkillJson?: string;
          },
        ) => {
          const apply = opts?.apply === true;
          let inRunSkillCandidates: ProcedurePromotionDuplicateCandidate[] | undefined;
          const raw = opts?.inRunSkillJson?.trim();
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as unknown;
              if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
              inRunSkillCandidates = parsed.map((entry, i) => {
                if (!entry || typeof entry !== "object") throw new Error(`index ${i}: expected object`);
                const o = entry as Record<string, unknown>;
                if (typeof o.slug !== "string" || typeof o.taskPattern !== "string") {
                  throw new Error(`index ${i}: slug and taskPattern must be strings`);
                }
                return { slug: o.slug, taskPattern: o.taskPattern };
              });
            } catch (err) {
              console.error(`error: --in-run-skill-json: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
              return;
            }
          }
          const result = generateAutoSkillForProcedure(
            factsDb,
            {
              skillsAutoPath: cfg.procedures.skillsAutoPath,
              skillsPendingPath: cfg.procedures.skillsPendingPath,
              requireApprovalForPromote: cfg.procedures.requireApprovalForPromote,
              validationThreshold: cfg.procedures.validationThreshold,
              skillTTLDays: cfg.procedures.skillTTLDays,
              procedureId: id,
              dryRun: opts?.dryRun === true || !apply,
              apply,
              policy: opts?.policy,
              requireValidation: opts?.force !== true,
              promotionContextSpecificPatterns: cfg.procedures.promotionContextSpecificPatterns,
              ...(inRunSkillCandidates ? { inRunSkillCandidates } : {}),
            },
            { info: (s) => console.log(s), warn: (s) => console.warn(s) },
          );

          if (opts?.json) {
            console.log(JSON.stringify({ id, ...result }, null, 2));
            if (!result.ok) process.exitCode = 1;
            return;
          }

          if (!result.ok) {
            if (result.reason === "not-found") {
              console.error(`error: procedure not found: ${id}`);
            } else if (result.reason === "validation-pending") {
              console.error(
                `error: procedure ${id} has not reached validationThreshold=${cfg.procedures.validationThreshold}; pass --force to override`,
              );
            } else if (result.reason === "policy-blocked") {
              console.error(
                `error: procedure ${id} blocked by promotion policy: ${
                  result.reasons?.join(", ") ?? "no reasons provided"
                }`,
              );
            } else {
              console.error(`error: failed to promote ${id}: ${result.error ?? "unknown error"}`);
            }
            process.exitCode = 1;
            return;
          }

          if (result.alreadyPromoted) {
            console.log(`Procedure ${id} already promoted (no-op).`);
            console.log(`  Skill: ${result.skillPath}`);
            return;
          }

          if (result.dryRun) {
            console.log(`[dry-run] would promote ${id} → ${result.skillPath}`);
            return;
          }

          console.log(`Promoted ${id} → ${result.skillPath}`);
        },
      ),
    );

  mem
    .command("version")
    .description("Show installed version and latest available on GitHub and npm")
    .option("--json", "Machine-readable JSON output")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        await runHybridMemVersion(ctx.versionInfo.pluginVersion, { json: opts?.json, format: "subcommand" });
      }),
    );

  mem
    .command("upgrade [version]")
    .description("Upgrade hybrid-mem to a specific version (or latest). Downloads and installs plugin from GitHub.")
    .action(
      withExit(async (version?: string) => {
        const res = await runUpgrade(version);
        if (res.ok) {
          console.log(`Upgraded to version ${res.version}. Plugin installed at: ${res.pluginDir}`);
          if (res.workspaceSkillPath) {
            console.log(
              `Workspace skill: ${res.workspaceSkillPath}${
                res.workspaceSkillError ? ` (warning: ${res.workspaceSkillError})` : ""
              }`,
            );
          }
          if (res.workspaceToolsMdPath) {
            const toolsSuffix = res.workspaceToolsMdError
              ? ` (warning: ${res.workspaceToolsMdError})`
              : res.workspaceToolsMdUpdated === true
                ? " (updated)"
                : res.workspaceToolsMdUpdated === false
                  ? " (unchanged)"
                  : "";
            console.log(`TOOLS.md: ${res.workspaceToolsMdPath}${toolsSuffix}`);
          }
        } else {
          console.error(`Error upgrading: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  mem
    .command("uninstall")
    .description("Uninstall hybrid-mem: clean plugin files, optionally remove from OpenClaw config")
    .option("--clean-all", "Remove all plugin data (SQLite, LanceDB, reports, config)")
    .option("--leave-config", "Keep OpenClaw config entry (just clean plugin files)")
    .action(
      withExit(async (opts?: { cleanAll?: boolean; leaveConfig?: boolean }) => {
        let res;
        try {
          res = await runUninstall({
            cleanAll: !!opts?.cleanAll,
            leaveConfig: !!opts?.leaveConfig,
          });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "uninstall",
          });
          throw err;
        }
        if (res.outcome === "config_updated") {
          console.log(`Uninstalled ${res.pluginId}: config updated, cleaned ${res.cleaned.length} files.`);
        } else if (res.outcome === "config_not_found") {
          console.log(`Uninstalled ${res.pluginId}: config not found, cleaned ${res.cleaned.length} files.`);
        } else if (res.outcome === "config_error") {
          console.error(
            `Uninstalled ${res.pluginId}: config error (${res.error}), cleaned ${res.cleaned.length} files.`,
          );
          process.exitCode = 1;
        } else if (res.outcome === "leave_config") {
          console.log(`Uninstalled ${res.pluginId}: config left intact, cleaned ${res.cleaned.length} files.`);
        }
      }),
    );

  // Issue #276 — Backup commands
  const backup = mem
    .command("backup")
    .description(
      `Create a snapshot backup of memory state (SQLite + LanceDB). Default destination: ~/.openclaw/backups/memory/TIMESTAMP/\n\nNOTE: To include memory in scheduled openclaw backups, add these paths to your openclaw.yaml backup config:\n  - ${
        resolvedSqlitePath ?? "<memoryDir>/memory.db"
      }\n  - ${resolvedLancePath ?? "<memoryDir>/lance/"}`,
    )
    .option("--dest <dir>", "Override backup destination directory")
    .action(
      withExit(async (opts?: { dest?: string }) => {
        if (!runBackup) {
          console.error("Backup is not available in this configuration.");
          process.exitCode = 1;
          return;
        }
        console.log("Creating memory backup…");
        const res = await runBackup({ backupDir: opts?.dest });

        // State file for heartbeat monitoring + health alerting (Issue #276 Gap 5; #2229/#2230).
        const backupStateFile = defaultBackupStateFilePath();
        const alertPolicy = resolveBackupAlertPolicy(cfg);

        if (res.ok) {
          const sqliteKb = (res.sqliteSize / 1024).toFixed(1);
          const lanceKb = (res.lancedbSize / 1024).toFixed(1);
          console.log(`✓ Backup complete in ${res.durationMs}ms`);
          console.log(`  Location: ${res.backupDir}`);
          console.log(`  SQLite:   ${sqliteKb} KB${res.integrityOk ? " (integrity OK)" : " ⚠ integrity check failed"}`);
          console.log(`  LanceDB:  ${lanceKb} KB`);
          if (!res.integrityOk) {
            console.warn("⚠ SQLite integrity check failed — backup may be from a corrupt source.");
            process.exitCode = 1;
          }
          if (res.snapshotSkewMs > 1000) {
            // SQLite and LanceDB are snapshotted sequentially, not atomically (#81) — a write
            // landing in this window can leave the two halves briefly out of sync.
            console.warn(
              `⚠ SQLite and LanceDB snapshots were taken ${res.snapshotSkewMs}ms apart; a write during that window may not be reflected consistently in both halves.`,
            );
          }
          recordBackupOutcome(backupStateFile, {
            ok: true,
            timestamp: nowIso(),
            backupDir: res.backupDir,
            sqliteSize: res.sqliteSize,
            lancedbSize: res.lancedbSize,
            durationMs: res.durationMs,
            integrityOk: res.integrityOk,
            snapshotSkewMs: res.snapshotSkewMs,
          });
          // A fresh success supersedes any stale failure/alert state (#2230) — nothing further to do.
        } else {
          console.error(`✗ Backup failed: ${res.error}`);
          recordBackupOutcome(backupStateFile, { ok: false, timestamp: nowIso(), error: res.error });
          console.error(`  ⚠ Backup failure recorded to: ${backupStateFile}`);
          const { alerted, alertMessage } = evaluateAndMaybeAlertBackupHealth(backupStateFile, alertPolicy);
          if (alerted && alertMessage) {
            console.error("");
            console.error(alertMessage);
          }
          process.exitCode = 1;
        }
      }),
    );

  backup
    .command("status")
    .description(
      "Backup retention + health audit: completed/retained/stale-partial snapshot counts, bytes, and last success/failure (Issues #2229, #2230).",
    )
    .option("--dest <dir>", "Backup root to inspect (default: ~/.openclaw/backups/memory/)")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { dest?: string; json?: boolean }) => {
        const root = opts?.dest ?? join(homedir(), ".openclaw", "backups", "memory");
        const retentionOpts = resolveBackupRetentionOptions(cfg);
        const status = getBackupStatus(root, retentionOpts);
        const stateFile = defaultBackupStateFilePath();
        const health = evaluateAndMaybeAlertBackupHealth(stateFile, {
          ...resolveBackupAlertPolicy(cfg),
          enabled: false, // status is a read-only audit view — never fire an alert as a side effect
        }).health;

        if (opts?.json) {
          console.log(JSON.stringify({ retention: retentionOpts, status, health }, null, 2));
          return;
        }

        console.log(`# Backup status (${root})`);
        console.log("");
        console.log(`Completed snapshots: ${status.completedCount} (retained by policy: ${status.retainedCount})`);
        console.log(`Stale/partial artifacts: ${status.stalePartialCount} (partial=${status.partialCount}, orphaned=${status.orphanedCount})`);
        console.log(`Total bytes (completed): ${formatBytes(status.totalBytes)}`);
        if (status.newest) console.log(`Newest: ${status.newest.name} (${formatBytes(status.newest.bytes)})`);
        if (status.oldest) console.log(`Oldest: ${status.oldest.name} (${formatBytes(status.oldest.bytes)})`);
        console.log("");
        console.log(`Health: ${health.status}${health.reasonCategory ? ` (${health.reasonCategory})` : ""}`);
        console.log(`Last verified success: ${health.lastSuccessAt ?? "never"}`);
        if (health.lastFailureAt) console.log(`Last failure: ${health.lastFailureAt} (consecutive: ${health.consecutiveFailures})`);
        if (health.ageSinceLastSuccessHours !== null) {
          console.log(`Age since last success: ${health.ageSinceLastSuccessHours.toFixed(1)}h`);
        }
        if (health.remediation.length > 0) {
          console.log("Next remediation:");
          for (const r of health.remediation) console.log(`  - ${r}`);
        }
        if (status.stalePartialCount > 0) {
          console.log(`Run \`openclaw hybrid-mem backup prune --dest ${root}\` to clean up stale/partial artifacts.`);
        }
        if (health.status === "failed" || health.status === "stale") process.exitCode = 1;
      }),
    );

  backup
    .command("prune")
    .description(
      "Deterministically clean up stale/partial backup artifacts and enforce retention (Issue #2229). Never deletes the newest completed snapshot.",
    )
    .option("--dest <dir>", "Backup root to prune (default: ~/.openclaw/backups/memory/)")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { dest?: string; json?: boolean }) => {
        const root = opts?.dest ?? join(homedir(), ".openclaw", "backups", "memory");
        const report = pruneBackups(root, resolveBackupRetentionOptions(cfg));
        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
          if (report.errors.length > 0) process.exitCode = 1;
          return;
        }
        console.log(`Retained: ${report.retainedCompleted.length}`);
        console.log(`Pruned completed (retention): ${report.prunedCompleted.length}`);
        console.log(`Pruned partial (abandoned runs): ${report.prunedPartial.length}`);
        console.log(`Pruned orphaned artifacts: ${report.prunedOrphaned.length}`);
        if (report.errors.length > 0) {
          console.log("Errors:");
          for (const e of report.errors) console.log(`  - ${e}`);
          process.exitCode = 1;
        }
      }),
    );

  backup
    .command("verify")
    .description("Verify SQLite DB integrity without creating a new backup.")
    .action(
      withExit(async () => {
        if (!runBackupVerify) {
          console.error("Backup verify is not available in this configuration.");
          process.exitCode = 1;
          return;
        }
        const res = runBackupVerify();
        if (res.ok) {
          const status = res.integrityOk ? "✓" : "✗";
          console.log(`${status} ${res.message}`);
          if (!res.integrityOk) process.exitCode = 1;
        } else {
          console.error(`✗ Verify failed: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  // Issue #276, Gap 4 — Schedule backup via system cron
  backup
    .command("schedule")
    .description(
      "Print cron setup instructions for automated weekly memory backups.\n\n" +
        "Installs a cron entry (schedule from config, default: weekly Sunday at 04:00) that runs\n" +
        "`hybrid-mem backup` and writes output to ~/.openclaw/logs/backup.log.\n\n" +
        "The backup state is recorded to ~/.openclaw/state/memory-backup-last.json\n" +
        "so HEARTBEAT.md monitoring can detect failures.",
    )
    .option("--dry-run", "Print the cron line without installing it")
    .action(
      withExit(async (opts?: { dryRun?: boolean }) => {
        // Use config-provided cron expression (falls back to the same default as parseCronReliabilityConfig)
        const cronExpr = cfg.maintenance?.cronReliability?.weeklyBackupCron ?? "0 4 * * 0";
        const hybridMemBin = "hybrid-mem"; // resolved by PATH at runtime
        const logDir = join(homedir(), ".openclaw", "logs");
        const logFile = join(logDir, "backup.log");
        const cronLine = `${cronExpr} ${hybridMemBin} backup >> ${shellQuotePathForCron(logFile)} 2>&1`;

        if (opts?.dryRun) {
          console.log("Cron line (dry-run — not installed):");
          console.log(`  ${cronLine}`);
          return;
        }

        // Attempt to install via crontab
        try {
          mkdirSync(logDir, { recursive: true });
        } catch {
          // Non-fatal
        }

        let currentCrontab = "";
        try {
          currentCrontab = execSync("crontab -l 2>/dev/null", {
            encoding: "utf-8",
          });
        } catch {
          // No existing crontab — that's fine
        }

        if (currentCrontab.includes("hybrid-mem backup")) {
          console.log("✓ A hybrid-mem backup cron entry already exists:");
          const existing = currentCrontab.split("\n").find((l) => l.includes("hybrid-mem backup"));
          if (existing) console.log(`  ${existing}`);
          return;
        }

        const newCrontab = `${(currentCrontab.trimEnd() ? `${currentCrontab.trimEnd()}\n` : "") + cronLine}\n`;
        try {
          const tmpFile = join(tmpdir(), `crontab-hybrid-mem-${Date.now()}.txt`);
          writeFileSync(tmpFile, newCrontab, "utf-8");
          execSync(`crontab ${tmpFile}`);
          try {
            unlinkSync(tmpFile);
          } catch {
            /* ignore */
          }
          console.log(`✓ Weekly backup scheduled (${cronExpr}).`);
          console.log(`  Log: ${logFile}`);
          console.log(`  State: ${join(homedir(), ".openclaw", "state", "memory-backup-last.json")}`);
          console.log("");
          console.log(
            "Backup health is monitored automatically: `openclaw hybrid-mem health` and `audit health`\n" +
              "surface a failed/stale backup, and the weekly audit-health maintenance job fires a\n" +
              "deduplicated alert (see maintenance.backup.alerting in config; docs/BACKUP.md). You can also\n" +
              "add a manual HEARTBEAT.md check as a belt-and-suspenders fallback:\n" +
              "  Check ~/.openclaw/state/memory-backup-last.json — if ok=false, alert Markus.",
          );
        } catch (err) {
          console.error(`✗ Failed to install crontab: ${err}`);
          console.log("");
          console.log("Add manually with: crontab -e");
          console.log(`  ${cronLine}`);
          process.exitCode = 1;
        }
      }),
    );
}
