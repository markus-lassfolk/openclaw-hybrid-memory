/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { type Chainable, relativeTime, withExit } from "../../shared.js";
import type {
  CredentialsAuditResult,
  CredentialsPruneResult,
  MigrateToVaultResult,
} from "../../types.js";
import type { ManageBindings } from "./bindings.js";

export function registerManageCredentialsAndScope(mem: Chainable, b: ManageBindings): void {
  const {
    factsDb,
    vectorDb,
    embeddings,
    cfg,
    mergeResults: merge,
    runMigrateToVault,
    runCredentialsList,
    runCredentialsGet,
    runCredentialsAudit,
    runCredentialsPrune,
  } = b;

  const credentials = mem.command("credentials").description("Manage credentials (vaulted)");
  credentials
    .command("migrate-to-vault")
    .description("Migrate credentials from plaintext to vaulted storage (one-time)")
    .action(
      withExit(async () => {
        let res;
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
        }
        console.log(`Migrated ${res.migrated} credentials (${res.skipped} skipped).`);
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
    .option(
      "--show-value",
      "Reveal the secret value in the default (metadata) output. Without this flag the value is masked for safety.",
    )
    .action(
      withExit(async (opts: { service: string; type?: string; valueOnly?: boolean; showValue?: boolean }) => {
        const entry = runCredentialsGet({ service: opts.service, type: opts.type });
        if (!entry) {
          console.error(
            `No credential found for service "${opts.service}"${opts.type ? ` (type: ${opts.type})` : ""}.`,
          );
          process.exitCode = 1;
          return;
        }
        if (opts.valueOnly) {
          console.log(entry.value);
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
      }),
    );

  credentials
    .command("audit")
    .description("Audit vault: flag suspicious entries (natural language, long service names, duplicates)")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const audit = runCredentialsAudit();
        if (opts?.json) {
          console.log(JSON.stringify({ total: audit.total, entries: audit.entries }, null, 2));
          return;
        }
        if (audit.total === 0) {
          console.log("No credentials in vault.");
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
    .action(
      withExit(async (opts: { scope: string; scopeTarget?: string }) => {
        const scopeFilter: ScopeFilter = {};
        if (opts.scope === "user") scopeFilter.userId = opts.scopeTarget || null;
        else if (opts.scope === "agent") scopeFilter.agentId = opts.scopeTarget || null;
        else if (opts.scope === "session") scopeFilter.sessionId = opts.scopeTarget || null;

        const deleted = factsDb.pruneScopedFacts(scopeFilter);
        console.log(
          `Pruned ${deleted} facts from scope ${opts.scope}${opts.scopeTarget ? ` (target=${opts.scopeTarget})` : ""}.`,
        );
      }),
    );
  scope
    ?.command("promote")
    .description("Promote high-importance session-scoped facts to global scope")
    .option("--dry-run", "Preview without making changes")
    .option("--threshold-days <n>", "Minimum age in days for a session fact to be promoted (default: 7)", "7")
    .option("--min-importance <n>", "Minimum importance score to promote (default: 0.7)", "0.7")
    .action(
      withExit(async (opts: { dryRun?: boolean; thresholdDays: string; minImportance: string }) => {
        const thresholdDays = Number.parseFloat(opts.thresholdDays);
        const minImportance = Number.parseFloat(opts.minImportance);

        if (Number.isNaN(thresholdDays) || thresholdDays < 0) {
          console.error("--threshold-days must be a non-negative number");
          process.exit(1);
        }
        if (Number.isNaN(minImportance) || minImportance < 0 || minImportance > 1) {
          console.error("--min-importance must be a number between 0 and 1");
          process.exit(1);
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
        for (const f of candidates) {
          if (factsDb.promoteScope(f.id, "global", null)) {
            promoted++;
          }
        }
        console.log(`Promoted ${promoted} facts from session to global scope.`);
      }),
    );
}
