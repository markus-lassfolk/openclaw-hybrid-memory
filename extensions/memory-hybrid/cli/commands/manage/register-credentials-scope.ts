/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { CREDENTIAL_TYPES, type CredentialType } from "../../../config.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { deleteVectorsForFactIds } from "../../../services/vector-maintenance.js";
import type { ScopeFilter } from "../../../types/memory.js";
import { withMachineOutputStdoutSuppressed } from "../../../utils/hybrid-mem-json-cli.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
import { type Chainable, withExit } from "../../shared.js";
import type { MigrateToVaultResult } from "../../types.js";
import type { ManageBindings } from "./bindings.js";
import { runMaintenanceHeartbeat } from "./maintenance-heartbeat.js";

/** Validates a `--type` value against the credential type enum, printing a standard CLI error. */
function parseRevisionCredentialType(raw: string): CredentialType | null {
  if ((CREDENTIAL_TYPES as readonly string[]).includes(raw)) return raw as CredentialType;
  console.error(`error: --type must be one of ${CREDENTIAL_TYPES.join(", ")}`);
  process.exitCode = 1;
  return null;
}

export function registerManageCredentialsAndScope(mem: Chainable, b: ManageBindings): void {
  const {
    factsDb,
    vectorDb,
    runMigrateToVault,
    runEncryptVault,
    runRekeyVault,
    runVaultStatus,
    runCredentialsList,
    runCredentialsGet,
    runCredentialsAudit,
    runCredentialsPrune,
    runCredentialRevisionList,
    runCredentialRevisionGet,
    runCredentialRevisionRestore,
    runCredentialRevisionPurge,
    runCredentialRevisionPin,
  } = b;

  const credentials = mem.command("credentials").description("Manage credentials (vaulted)");
  credentials
    .command("migrate-to-vault")
    .description("Migrate credentials from plaintext to vaulted storage (one-time)")
    .action(
      withExit(async () => {
        let res: MigrateToVaultResult | null;
        try {
          res = await runMigrateToVault();
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "migrate-to-vault",
          });
          throw err;
        }
        if (!res) {
          console.log("No credentials to migrate (or migration already done).");
          return;
        }
        if (res.errors.length > 0) {
          console.error(`Errors during migration: ${res.errors.join(", ")}`);
          process.exitCode = 1;
        }
        console.log(`Migrated ${res.migrated} credentials (${res.skipped} skipped).`);
      }),
    );

  credentials
    .command("vault-status")
    .description("Show vault encryption status (kdf_version, entry count, migration readiness)")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const status = runVaultStatus();
        if (!status) {
          if (opts?.json) {
            console.log(JSON.stringify(null));
          } else {
            console.log("Credentials vault is not available (disabled or not configured).");
          }
          return;
        }
        if (opts?.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        const encLabel = status.encryptedAtRest
          ? `encrypted (kdf_version=${status.kdfVersion})`
          : `plaintext (kdf_version=${status.kdfVersion})`;
        console.log(`Vault path:  ${status.dbPath}`);
        console.log(`Status:      ${encLabel}`);
        console.log(`Entries:     ${status.entryCount}`);
        console.log(`Key present: ${status.configuredKeyPresent}`);
        if (status.migrationRequired) {
          console.log("⚠  Migration required: vault is plaintext but an encryption key is configured.");
          console.log("   Run: openclaw hybrid-mem credentials encrypt-vault --backup --verify --yes");
        }
        if (status.legacyLiteralFileKey) {
          console.log("⚠  Legacy key material: vault was opened using the literal file:/path ref as the passphrase");
          console.log(
            "   itself, not the file's contents. New installs should use file contents via file:/path/to/key.",
          );
          if (status.legacyLiteralFileKeyRemediation) {
            console.log(`   ${status.legacyLiteralFileKeyRemediation}`);
          }
        }
      }),
    );

  credentials
    .command("rekey-vault")
    .description("Re-encrypt an encrypted vault with the configured encryption key (legacy file: ref migration)")
    .option("--yes", "Apply changes (default: dry-run)")
    .option("--backup", "Create a backup of the encrypted vault before rekeying (recommended)")
    .option("--backup-path <path>", "Custom path for the backup file (implies --backup)")
    .option("--verify", "Verify all entries are readable after rekeying")
    .action(
      withExit(async (opts?: { yes?: boolean; backup?: boolean; backupPath?: string; verify?: boolean }) => {
        const res = runRekeyVault({
          yes: opts?.yes === true,
          backup: opts?.backup === true || opts?.backupPath !== undefined,
          backupPath: opts?.backupPath,
          verify: opts?.verify === true,
        });
        if (!res.ok) {
          console.error(`Rekey vault: FAIL — ${res.error}`);
          process.exitCode = 1;
          return;
        }
        if (res.dryRun) {
          console.log(`Vault is encrypted (kdf_version=${res.status.kdfVersion}).`);
          console.log(`Vault path: ${res.vaultPath}`);
          console.log(
            `Preflight: backup path writable=${res.preflight.backupPathWritable}` +
              (res.preflight.targetKeyFileReadable === null
                ? ""
                : `, target key file readable=${res.preflight.targetKeyFileReadable}`),
          );
          if (!res.preflight.backupPathWritable) {
            console.log("⚠  Backup directory is not writable — fix permissions before running with --backup --yes.");
          }
          if (res.preflight.targetKeyFileReadable === false) {
            console.log(
              "⚠  Configured credentials.encryptionKey file: ref could not be read — fix it before rekeying.",
            );
          }
          console.log("Dry-run only. To re-encrypt with the configured key material, run:");
          console.log("  openclaw hybrid-mem credentials rekey-vault --backup --verify --yes");
          return;
        }
        console.log(
          `Rekeyed vault (kdf_version=${res.status.kdfVersion}). Re-encrypted ${res.rekeyed} entr${
            res.rekeyed === 1 ? "y" : "ies"
          }.`,
        );
        if (res.backupPath) console.log(`Backup created at: ${res.backupPath}`);
        if (res.verified === true) console.log("Verification: all entries readable ✓");
        console.log("Restart the gateway (or re-run verify) to confirm.");
      }),
    );

  credentials
    .command("encrypt-vault")
    .description("Encrypt an existing plaintext credentials vault at rest (kdf_version=0 → scrypt/AES-GCM)")
    .option("--yes", "Apply changes (default: dry-run)")
    .option("--backup", "Create a consistent plaintext backup before encrypting (recommended)")
    .option("--backup-path <path>", "Custom path for the backup file (implies --backup)")
    .option("--verify", "Verify all entries are readable after encryption")
    .action(
      withExit(async (opts?: { yes?: boolean; backup?: boolean; backupPath?: string; verify?: boolean }) => {
        const res = runEncryptVault({
          yes: opts?.yes === true,
          backup: opts?.backup === true || opts?.backupPath !== undefined,
          backupPath: opts?.backupPath,
          verify: opts?.verify === true,
        });
        if (!res.ok) {
          console.error(`Encrypt vault: FAIL — ${res.error}`);
          process.exitCode = 1;
          return;
        }
        if (res.dryRun) {
          if (res.status.encryptedAtRest) {
            console.log(`Vault already encrypted (kdf_version=${res.status.kdfVersion}).`);
            return;
          }
          console.log(`Vault is plaintext (kdf_version=${res.status.kdfVersion}).`);
          console.log(`Vault path: ${res.vaultPath}`);
          console.log("Dry-run only. To encrypt the existing vault at rest, run:");
          console.log("  openclaw hybrid-mem credentials encrypt-vault --backup --verify --yes");
          return;
        }
        console.log(
          `Encrypted vault at rest (kdf_version=${res.status.kdfVersion}). Migrated ${res.migrated} entr${
            res.migrated === 1 ? "y" : "ies"
          }.`,
        );
        if (res.backupPath) {
          console.log(`Backup created at: ${res.backupPath}`);
        }
        if (res.verified === true) {
          console.log("Verification: all entries readable ✓");
        }
        console.log("Restart the gateway (or re-run verify) to confirm.");
      }),
    );

  credentials
    .command("list")
    .description(
      "List credentials in vault (service, type, url only — no values). One entry per (service, type); repeated stores overwrite.",
    )
    .option(
      "--service <pattern>",
      "Filter by service name (case-insensitive substring match). Note: partial patterns match all services containing the string — e.g. 'git' matches 'github' and 'gitea'. Use quotes for multi-word patterns.",
    )
    .action(
      withExit(async (opts?: { service?: string }) => {
        let list = runCredentialsList();
        if (list.length === 0) {
          console.log("No credentials in vault.");
          return;
        }
        const pattern = opts?.service?.trim();
        if (pattern) {
          const lower = pattern.toLowerCase();
          list = list.filter((e) => e.service.toLowerCase().includes(lower));
          if (list.length === 0) {
            console.log(`No credentials matching service "${pattern}".`);
            return;
          }
          console.log(
            `Credentials matching "${pattern}" (case-insensitive substring, ${list.length} result${list.length === 1 ? "" : "s"}):`,
          );
        } else {
          console.log(`Credentials (${list.length}):`);
        }
        for (const e of list) {
          console.log(`  ${e.service} (${e.type})${e.url ? ` — ${e.url}` : ""}`);
        }
      }),
    );

  credentials
    .command("get")
    .description(
      "Retrieve a credential value by service name. Omit --type to get the most recently updated credential for the service, or use --type to disambiguate when multiple types exist.",
    )
    .requiredOption("--service <name>", "Service name (e.g. 'unifi', 'github')")
    .option(
      "--type <type>",
      "Credential type (token, password, api_key, ssh, bearer, other). Omit to get the most recently updated entry for the service, or when you don't know which type is stored.",
    )
    .option(
      "--value-only",
      "Print only the secret value (for piping); no metadata. Warning: value is printed in plaintext.",
    )
    .option("--quiet", "Alias for --value-only (machine-readable stdout for scripting)")
    .option(
      "--show-value",
      "Reveal the secret value in the default (metadata) output. Without this flag the value is masked for safety.",
    )
    .action(
      withExit(
        async (opts: { service: string; type?: string; valueOnly?: boolean; quiet?: boolean; showValue?: boolean }) => {
          const valueOnly = opts.valueOnly === true || opts.quiet === true;
          const entry = runCredentialsGet({ service: opts.service, type: opts.type });
          if (!entry) {
            console.error(
              `No credential found for service "${opts.service}"${opts.type ? ` (type: ${opts.type})` : ""}.`,
            );
            process.exitCode = 1;
            return;
          }
          if (valueOnly) {
            withMachineOutputStdoutSuppressed(() => {
              process.stdout.write(entry.value);
            });
            return;
          }
          console.log(`service: ${entry.service}`);
          console.log(`type: ${entry.type}`);
          if (opts.showValue) {
            console.log(`value: ${entry.value}`);
          } else {
            console.log("value: *** (use --show-value to reveal, or --value-only to pipe)");
          }
          if (entry.url) console.log(`url: ${entry.url}`);
          if (entry.notes) console.log(`notes: ${entry.notes}`);
        },
      ),
    );

  credentials
    .command("audit")
    .description("Audit vault: flag suspicious entries (natural language, long service names, duplicates)")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const audit = runCredentialsAudit();
        if (opts?.json) {
          console.log(
            JSON.stringify({ total: audit.total, entries: audit.entries, undecryptable: audit.undecryptable }, null, 2),
          );
          return;
        }
        if (audit.undecryptable > 0) {
          console.log(
            `WARNING: ${audit.undecryptable} credential row(s) could not be decrypted with the current key and are excluded below — this usually means the wrong/rotated encryption key is configured, not that the vault is empty.`,
          );
        }
        if (audit.total === 0) {
          console.log(audit.undecryptable > 0 ? "No decryptable credentials in vault." : "No credentials in vault.");
          return;
        }
        const suspicious = audit.entries.filter((e) => e.flags.length > 0);
        console.log(`Audit: ${audit.total} total, ${suspicious.length} suspicious.`);
        for (const e of audit.entries) {
          const flagStr = e.flags.length > 0 ? ` [${e.flags.join(", ")}]` : "";
          console.log(`  ${e.service} (${e.type})${flagStr}`);
        }
      }),
    );

  credentials
    .command("prune")
    .description("Remove suspicious credential entries (default: dry-run; use --yes to apply)")
    .option("--dry-run", "Only list what would be removed (default)")
    .option("--yes", "Actually remove flagged entries")
    .option("--only-flags <reasons>", "Comma-separated flags to prune (e.g. natural_language,service_too_long)")
    .action(
      withExit(async (opts?: { dryRun?: boolean; yes?: boolean; onlyFlags?: string }) => {
        const yes = opts?.yes === true;
        const dryRun = yes ? false : opts?.dryRun !== false;
        const onlyFlags = opts?.onlyFlags
          ? opts.onlyFlags
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        const res = runCredentialsPrune({ dryRun, yes, onlyFlags });
        if (res.undecryptable > 0) {
          console.log(
            `WARNING: ${res.undecryptable} credential row(s) could not be decrypted with the current key and were skipped — not evaluated for pruning.`,
          );
        }
        if (res.removed === 0) {
          console.log(res.dryRun ? "No suspicious entries to prune (dry-run)." : "No entries removed.");
          return;
        }
        if (res.dryRun) {
          console.log(`Would remove ${res.removed} entries (run with --yes to apply):`);
          for (const e of res.entries) {
            console.log(`  ${e.service} (${e.type})`);
          }
        } else {
          console.log(`Removed ${res.removed} entries.`);
        }
      }),
    );

  const revisions = credentials
    .command("revisions")
    .description("Manage historical credential revisions — kept when an existing credential is overwritten (#2104)");

  revisions
    .command("list")
    .description("List historical revisions for a credential (metadata only — values are never listed)")
    .requiredOption("--service <name>", "Service name")
    .requiredOption("--type <type>", "Credential type (token, password, api_key, ssh, bearer, other)")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts: { service: string; type: string; json?: boolean }) => {
        const type = parseRevisionCredentialType(opts.type);
        if (!type) return;
        const revs = runCredentialRevisionList({ service: opts.service, type });
        if (revs === null) {
          console.log("Credentials vault is not available (disabled or not configured).");
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(revs, null, 2));
          return;
        }
        if (revs.length === 0) {
          console.log(`No revisions found for ${opts.service} (${type}).`);
          return;
        }
        console.log(`Revisions for ${opts.service} (${type}) — newest first:`);
        for (const r of revs) {
          const expiry = r.pinnedAt
            ? "pinned (never expires)"
            : r.expiresAt
              ? `expires ${new Date(r.expiresAt * 1000).toISOString()}`
              : "no expiry";
          console.log(
            `  ${r.id}  replaced ${new Date(r.replacedAt * 1000).toISOString()}  ${expiry}${r.url ? `  url=${r.url}` : ""}`,
          );
        }
      }),
    );

  revisions
    .command("get")
    .description("Retrieve a specific revision's value intentionally (never shown by `revisions list`)")
    .requiredOption("--service <name>", "Service name")
    .requiredOption("--type <type>", "Credential type")
    .requiredOption("--revision <id>", "Revision id (from `credentials revisions list`)")
    .option("--show-value", "Reveal the secret value in the default output. Without this the value is masked.")
    .option("--value-only", "Print only the secret value (for piping); no metadata.")
    .option("--json", "Output as JSON")
    .action(
      withExit(
        async (opts: {
          service: string;
          type: string;
          revision: string;
          showValue?: boolean;
          valueOnly?: boolean;
          json?: boolean;
        }) => {
          const type = parseRevisionCredentialType(opts.type);
          if (!type) return;
          const entry = runCredentialRevisionGet({ service: opts.service, type, revision: opts.revision });
          if (!entry) {
            console.error(`No revision "${opts.revision}" found for ${opts.service} (${type}).`);
            process.exitCode = 1;
            return;
          }
          if (opts.valueOnly) {
            withMachineOutputStdoutSuppressed(() => {
              process.stdout.write(entry.value);
            });
            return;
          }
          if (opts.json) {
            console.log(JSON.stringify(entry, null, 2));
            return;
          }
          console.log(`revision: ${entry.id}`);
          console.log(`service: ${entry.service}`);
          console.log(`type: ${entry.type}`);
          if (opts.showValue) {
            console.log(`value: ${entry.value}`);
          } else {
            console.log("value: *** (use --show-value to reveal, or --value-only to pipe)");
          }
          if (entry.url) console.log(`url: ${entry.url}`);
          if (entry.notes) console.log(`notes: ${entry.notes}`);
          console.log(`replacedAt: ${new Date(entry.replacedAt * 1000).toISOString()}`);
          console.log(
            entry.pinnedAt
              ? "pinned: yes"
              : `expiresAt: ${entry.expiresAt ? new Date(entry.expiresAt * 1000).toISOString() : "n/a"}`,
          );
        },
      ),
    );

  revisions
    .command("restore")
    .description("Restore/promote a historical revision back to current (default: dry-run; use --yes to apply)")
    .requiredOption("--service <name>", "Service name")
    .requiredOption("--type <type>", "Credential type")
    .requiredOption("--revision <id>", "Revision id to restore")
    .option("--yes", "Apply the restore (default: dry-run preview)")
    .action(
      withExit(async (opts: { service: string; type: string; revision: string; yes?: boolean }) => {
        const type = parseRevisionCredentialType(opts.type);
        if (!type) return;
        if (!opts.yes) {
          const existing = runCredentialRevisionList({ service: opts.service, type });
          if (existing === null) {
            console.log("Credentials vault is not available (disabled or not configured).");
            return;
          }
          const match = existing.find((r) => r.id === opts.revision);
          if (!match) {
            console.error(`No revision "${opts.revision}" found for ${opts.service} (${type}).`);
            process.exitCode = 1;
            return;
          }
          console.log(
            `Would restore revision ${match.id} (replaced ${new Date(match.replacedAt * 1000).toISOString()}) to current for ${opts.service} (${type}).`,
          );
          console.log("Dry-run only. Run with --yes to apply.");
          return;
        }
        const restored = runCredentialRevisionRestore({ service: opts.service, type, revision: opts.revision });
        if (!restored) {
          console.error(`No revision "${opts.revision}" found for ${opts.service} (${type}), or vault disabled.`);
          process.exitCode = 1;
          return;
        }
        console.log(`Restored revision ${opts.revision} to current for ${opts.service} (${type}).`);
      }),
    );

  revisions
    .command("purge")
    .description("Hard-delete revision(s) — cannot be undone (default: dry-run; use --yes to apply)")
    .requiredOption("--service <name>", "Service name")
    .requiredOption("--type <type>", "Credential type")
    .option("--revision <id>", "Revision id to purge (omit when --all is set)")
    .option("--all", "Purge every revision for this service/type")
    .option("--yes", "Apply the purge (default: dry-run preview)")
    .action(
      withExit(async (opts: { service: string; type: string; revision?: string; all?: boolean; yes?: boolean }) => {
        const type = parseRevisionCredentialType(opts.type);
        if (!type) return;
        if (!opts.revision && !opts.all) {
          console.error("error: specify --revision <id> or --all");
          process.exitCode = 1;
          return;
        }
        const existing = runCredentialRevisionList({ service: opts.service, type });
        if (existing === null) {
          console.log("Credentials vault is not available (disabled or not configured).");
          return;
        }
        const targets = opts.all ? existing : existing.filter((r) => r.id === opts.revision);
        if (targets.length === 0) {
          console.log(
            opts.all
              ? `No revisions to purge for ${opts.service} (${type}).`
              : `No revision "${opts.revision}" found for ${opts.service} (${type}).`,
          );
          return;
        }
        if (!opts.yes) {
          console.log(`Would purge ${targets.length} revision(s) for ${opts.service} (${type}):`);
          for (const r of targets) console.log(`  ${r.id}`);
          console.log("Dry-run only. Run with --yes to apply.");
          return;
        }
        const result = runCredentialRevisionPurge({
          service: opts.service,
          type,
          revision: opts.revision,
          all: opts.all,
        });
        console.log(`Purged ${result?.purged ?? 0} revision(s) for ${opts.service} (${type}).`);
      }),
    );

  revisions
    .command("pin")
    .description("Pin a revision so it never expires, or --unpin to re-expose it to normal TTL expiry")
    .requiredOption("--service <name>", "Service name")
    .requiredOption("--type <type>", "Credential type")
    .requiredOption("--revision <id>", "Revision id")
    .option("--unpin", "Unpin instead of pin")
    .action(
      withExit(async (opts: { service: string; type: string; revision: string; unpin?: boolean }) => {
        const type = parseRevisionCredentialType(opts.type);
        if (!type) return;
        const pinned = !opts.unpin;
        const result = runCredentialRevisionPin({ service: opts.service, type, revision: opts.revision, pinned });
        if (result === null) {
          console.log("Credentials vault is not available (disabled or not configured).");
          return;
        }
        if (!result.changed) {
          console.error(`No revision "${opts.revision}" found for ${opts.service} (${type}).`);
          process.exitCode = 1;
          return;
        }
        console.log(
          `Revision ${opts.revision} for ${opts.service} (${type}) is now ${pinned ? "pinned" : "unpinned"}.`,
        );
      }),
    );

  const scope = mem.command("scope").description("Manage memory scopes (global, user, agent, session)");
  scope
    .command("list")
    .description("List all scopes in memory (discovered from facts)")
    .action(
      withExit(async () => {
        const scopes = factsDb.uniqueScopes();
        console.log(`Scopes in memory (${scopes.length}):`);
        for (const s of scopes) {
          console.log(`  - ${s}`);
        }
      }),
    );
  scope
    .command("stats")
    .description("Show scope statistics (count by scope)")
    .action(
      withExit(async () => {
        const stats = factsDb.scopeStats();
        console.log("Scope stats:");
        for (const [s, count] of Object.entries(stats)) {
          console.log(`  ${s}: ${count}`);
        }
      }),
    );
  scope
    ?.command("prune")
    .description("Prune all facts in a specific scope (WARNING: destructive)")
    .requiredOption("--scope <s>", "Scope to prune (global/user/agent/session)")
    .option(
      "--scope-target <st>",
      "Scope target (userId/agentId/sessionId). Required when scope is user/agent/session.",
    )
    .option("--dry-run", "Preview what would be deleted without making any changes")
    .option("--yes", "Skip the confirmation prompt and execute immediately")
    .action(
      withExit(async (opts: { scope: string; scopeTarget?: string; dryRun?: boolean; yes?: boolean }) => {
        const scope = opts.scope.trim().toLowerCase();
        const scopeTarget = opts.scopeTarget?.trim();
        if (!["global", "user", "agent", "session"].includes(scope)) {
          console.error("error: --scope must be one of global/user/agent/session");
          process.exitCode = 1;
          return;
        }
        if (scope === "global" && scopeTarget) {
          console.error("error: --scope-target is not allowed when --scope=global");
          process.exitCode = 1;
          return;
        }
        if (scope !== "global" && !scopeTarget) {
          console.error(`error: --scope-target is required when --scope=${scope}`);
          process.exitCode = 1;
          return;
        }

        const scopeFilter: ScopeFilter = {};
        if (scope === "global") scopeFilter.global = true;
        else if (scope === "user") scopeFilter.userId = scopeTarget ?? null;
        else if (scope === "agent") scopeFilter.agentId = scopeTarget ?? null;
        else if (scope === "session") scopeFilter.sessionId = scopeTarget ?? null;

        const scopeLabel = `${scope}${scopeTarget ? ` (target=${scopeTarget})` : ""}`;

        if (opts.dryRun) {
          // Dry-run preview only — not used for the actual delete below, since a fact could
          // enter or leave the scope between this preview and a later confirmed run.
          const pendingIds = factsDb.listScopedFactIdsPendingPrune(scopeFilter);
          console.log(`Dry-run: would delete ${pendingIds.length} fact(s) from scope ${scopeLabel}.`);
          const previewIds = pendingIds.slice(0, 20);
          const previewFacts = factsDb.getByIds(previewIds);
          for (const id of previewIds) {
            const f = previewFacts.get(id);
            if (f) console.log(`  [${id.slice(0, 8)}] "${f.text.slice(0, 80)}"`);
          }
          if (pendingIds.length > 20) console.log(`  … and ${pendingIds.length - 20} more`);
          return;
        }

        // Safety gate: require explicit --yes for destructive operations.
        if (!opts.yes) {
          console.error(
            "error: scope prune is destructive and cannot be undone. Pass --yes to confirm, or use --dry-run to preview.",
          );
          process.exitCode = 1;
          return;
        }

        const deletedIds = factsDb.pruneScopedFacts(scopeFilter);
        console.log(`Pruned ${deletedIds.length} facts from scope ${scopeLabel}.`);

        // Clean up orphaned LanceDB vectors for the facts actually deleted above (not a
        // pre-delete snapshot, which can drift and leave a deleted fact's vector orphaned).
        if (deletedIds.length > 0) {
          try {
            const vectorCleanup = await deleteVectorsForFactIds(vectorDb, deletedIds, {
              operation: "scope-prune-vector-cleanup",
            });
            if (vectorCleanup.attempted > 0) {
              if (vectorCleanup.failed > 0) {
                console.error(
                  `Warning: vector cleanup partial — deleted ${vectorCleanup.deleted}/${vectorCleanup.attempted}, failed ${vectorCleanup.failed}. Run 'hybrid-mem storage repair' to reconcile.`,
                );
                process.exitCode = 2;
              } else {
                console.log(`Cleaned up ${vectorCleanup.deleted} vector(s) from LanceDB.`);
              }
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "scope-prune-vector-cleanup",
            });
            console.error(`Warning: vector cleanup failed: ${err}. Run 'hybrid-mem storage repair' to reconcile.`);
            process.exitCode = 2;
          }
        }
      }),
    );
  scope
    ?.command("promote")
    .description("Promote high-importance session-scoped facts to global scope")
    .option("--dry-run", "Preview without making changes")
    .option("--threshold-days <n>", "Minimum age in days for a session fact to be promoted (default: 7)", "7")
    .option("--min-importance <n>", "Minimum importance score to promote (default: 0.7)", "0.7")
    .option("-v, --verbose", "Emit periodic progress heartbeat for long runs")
    .action(
      withExit(
        async (
          opts: { dryRun?: boolean; thresholdDays: string; minImportance: string; verbose?: boolean },
          cmd?: CommanderOptsParent,
        ) => {
          const verbose = !!opts.verbose || readHybridMemVerbose(cmd);
          const thresholdDays = Number.parseFloat(opts.thresholdDays);
          const minImportance = Number.parseFloat(opts.minImportance);

          if (Number.isNaN(thresholdDays) || thresholdDays < 0) {
            console.error("--threshold-days must be a non-negative number");
            process.exitCode = 1;
            return;
          }
          if (Number.isNaN(minImportance) || minImportance < 0 || minImportance > 1) {
            console.error("--min-importance must be a number between 0 and 1");
            process.exitCode = 1;
            return;
          }

          const candidates = factsDb.findSessionFactsForPromotion(thresholdDays, minImportance);
          if (candidates.length === 0) {
            console.log("No session facts eligible for promotion.");
            return;
          }

          if (opts.dryRun) {
            console.log(`Would promote ${candidates.length} facts from session to global scope (dry-run):`);
            for (const f of candidates) {
              console.log(
                `  [${f.id}] importance=${f.importance.toFixed(2)} scope_target=${f.scopeTarget ?? "null"} text="${f.text.slice(0, 80)}"`,
              );
            }
            return;
          }

          let promoted = 0;
          let skipped = 0;
          let failed = 0;
          const reportEvery = 100;
          await runMaintenanceHeartbeat(
            "scope-promote",
            verbose,
            (heartbeat) => {
              for (let i = 0; i < candidates.length; i++) {
                const outcome = factsDb.promoteScopeToGlobalWithOutcome(candidates[i].id);
                if (outcome === "promoted") promoted++;
                else if (outcome === "skipped") skipped++;
                else failed++;
                if ((i + 1) % reportEvery === 0 || i === candidates.length - 1) heartbeat.heartbeat();
              }
            },
            {
              progressSupplier: () =>
                `stage=promote-scope; scanned=${promoted + skipped + failed}/${candidates.length}; promoted=${promoted}; skipped=${skipped}; failed=${failed}`,
            },
          );
          const summary = `scope-promote promoted=${promoted}/${candidates.length} skipped=${skipped} failed=${failed} semantic=${failed > 0 ? "partial" : "success"}`;
          console.log(summary);
          if (failed > 0) {
            process.exitCode = 2;
          }
        },
      ),
    );
}
