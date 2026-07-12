/**
 * CLI registration for `issues create|list|update|search|link-fact|show` (issue #2090).
 *
 * `memory_issue_*` has been agent-tool-only; operators had no CLI fallback for issue lifecycle
 * tracking when Tool Search wrappers were stale/degraded. Thin wrappers over the same IssueStore
 * methods the tools use — no scope filter (CLI is an operator-trusted context, same convention as
 * every other hybrid-mem command that touches factsDb/issueStore directly).
 */

import type { Issue, IssueSeverity, IssueStatus } from "../../../types/issue-types.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

const ISSUE_STATUSES = ["open", "diagnosed", "fix-attempted", "resolved", "verified", "wont-fix"] as const;
const ISSUE_SEVERITIES = ["low", "medium", "high", "critical"] as const;

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items;
}

function formatIssueLine(issue: Issue): string {
  return `[${issue.id.slice(0, 8)}] ${issue.title} — ${issue.status} (${issue.severity})`;
}

export function registerManageIssueTools(mem: Chainable, b: ManageBindings): void {
  const { issueStore, factsDb } = b;

  const issues = mem.command("issues").description("Create, update, list, search, and link tracked issues (#2090).");

  function requireIssueStore(): NonNullable<ManageBindings["issueStore"]> {
    if (!issueStore) throw new Error("Issue tracking is unavailable (issueStore not configured).");
    return issueStore;
  }

  issues
    .command("create <title>")
    .description(
      `Create a tracked issue. Lifecycle: open -> diagnosed -> fix-attempted -> resolved -> verified (or wont-fix). Severities: ${ISSUE_SEVERITIES.join(", ")}.`,
    )
    .requiredOption("--symptoms <list>", "Comma-separated observable symptoms or error messages")
    .option("--severity <sev>", `Severity (${ISSUE_SEVERITIES.join("|")})`)
    .option("--tags <list>", "Comma-separated tags")
    .option("--json", "Output as JSON")
    .action(
      withExit(
        async (title: string, opts?: { symptoms?: string; severity?: string; tags?: string; json?: boolean }) => {
          const store = requireIssueStore();
          const severity = opts?.severity as IssueSeverity | undefined;
          if (severity && !(ISSUE_SEVERITIES as readonly string[]).includes(severity)) {
            throw new Error(`--severity must be one of: ${ISSUE_SEVERITIES.join(", ")}`);
          }
          const symptoms = splitList(opts?.symptoms) ?? [];
          const issue = store.create({ title, symptoms, severity, tags: splitList(opts?.tags) });
          if (opts?.json) {
            console.log(JSON.stringify(issue, null, 2));
            return;
          }
          console.log(
            `Created issue "${issue.title}" [${issue.id}] (status: ${issue.status}, severity: ${issue.severity})`,
          );
        },
      ),
    );

  issues
    .command("update <id>")
    .description(
      "Update fields and/or advance status. Setting --status validates the allowed transition; 'resolved' auto-sets resolvedAt, 'verified' auto-sets verifiedAt.",
    )
    .option("--status <status>", `New status (${ISSUE_STATUSES.join("|")})`)
    .option("--root-cause <text>", "Root cause diagnosis")
    .option("--fix <text>", "Description of the applied fix")
    .option("--rollback <text>", "Rollback procedure if the fix fails")
    .option("--symptoms <list>", "Comma-separated updated list of symptoms")
    .option("--json", "Output as JSON")
    .action(
      withExit(
        async (
          id: string,
          opts?: {
            status?: string;
            rootCause?: string;
            fix?: string;
            rollback?: string;
            symptoms?: string;
            json?: boolean;
          },
        ) => {
          const store = requireIssueStore();
          const status = opts?.status as IssueStatus | undefined;
          if (status && !(ISSUE_STATUSES as readonly string[]).includes(status)) {
            throw new Error(`--status must be one of: ${ISSUE_STATUSES.join(", ")}`);
          }
          const symptoms = splitList(opts?.symptoms);
          const issue = status
            ? store.transition(id, status, {
                rootCause: opts?.rootCause,
                fix: opts?.fix,
                rollback: opts?.rollback,
                symptoms,
              })
            : store.update(id, { rootCause: opts?.rootCause, fix: opts?.fix, rollback: opts?.rollback, symptoms });
          if (opts?.json) {
            console.log(JSON.stringify(issue, null, 2));
            return;
          }
          console.log(`Updated issue "${issue.title}" [${issue.id}] (status: ${issue.status})`);
        },
      ),
    );

  issues
    .command("list")
    .description("List tracked issues with optional filters")
    .option("--status <list>", "Comma-separated status filter")
    .option("--severity <list>", "Comma-separated severity filter")
    .option("--tags <list>", "Comma-separated tag filter (any match)")
    .option("--limit <n>", "Maximum number of results (default 50, max 500)")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { status?: string; severity?: string; tags?: string; limit?: string; json?: boolean }) => {
        const store = requireIssueStore();
        const limitRaw = opts?.limit ? Number.parseInt(opts.limit, 10) : undefined;
        if (opts?.limit !== undefined && (!Number.isFinite(limitRaw) || (limitRaw as number) <= 0)) {
          throw new Error(`Invalid --limit value: ${opts.limit}`);
        }
        const statusFilter = splitList(opts?.status);
        for (const s of statusFilter ?? []) {
          if (!(ISSUE_STATUSES as readonly string[]).includes(s)) {
            throw new Error(`--status contains an invalid value "${s}"; must be one of: ${ISSUE_STATUSES.join(", ")}`);
          }
        }
        const severityFilter = splitList(opts?.severity);
        for (const s of severityFilter ?? []) {
          if (!(ISSUE_SEVERITIES as readonly string[]).includes(s)) {
            throw new Error(
              `--severity contains an invalid value "${s}"; must be one of: ${ISSUE_SEVERITIES.join(", ")}`,
            );
          }
        }
        // IssueStore.list() only appends LIMIT when limit > 0 — clamp like the memory_issue_list
        // tool does so an unset/invalid limit can't silently return the entire table.
        const limit = typeof limitRaw === "number" ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 50;
        const list = store.list({
          status: statusFilter as IssueStatus[] | undefined,
          severity: severityFilter,
          tags: splitList(opts?.tags),
          limit,
        });
        if (opts?.json) {
          console.log(JSON.stringify(list, null, 2));
          return;
        }
        console.log(list.length === 0 ? "No issues found." : `${list.length} issue(s):`);
        for (const issue of list) console.log(formatIssueLine(issue));
      }),
    );

  issues
    .command("search <query>")
    .description("Search issues by title and symptoms (LIKE-based text matching)")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (query: string, opts?: { json?: boolean }) => {
        const store = requireIssueStore();
        const results = store.search(query);
        if (opts?.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }
        console.log(results.length === 0 ? "No matching issues." : `${results.length} issue(s):`);
        for (const issue of results) console.log(formatIssueLine(issue));
      }),
    );

  issues
    .command("show <id>")
    .description("Show one issue")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (id: string, opts?: { json?: boolean }) => {
        const store = requireIssueStore();
        const issue = store.get(id);
        if (!issue) throw new Error(`Issue not found: ${id}`);
        if (opts?.json) {
          console.log(JSON.stringify(issue, null, 2));
          return;
        }
        console.log(formatIssueLine(issue));
        console.log(`  symptoms: ${issue.symptoms.join(", ") || "(none)"}`);
        console.log(`  tags: ${issue.tags.join(", ") || "(none)"}`);
        console.log(`  relatedFacts: ${issue.relatedFacts.length}`);
        if (issue.rootCause) console.log(`  rootCause: ${issue.rootCause}`);
        if (issue.fix) console.log(`  fix: ${issue.fix}`);
      }),
    );

  issues
    .command("link-fact <issueId> <factId>")
    .description("Associate a memory fact with an issue for cross-referencing")
    .action(
      withExit(async (issueId: string, factId: string) => {
        const store = requireIssueStore();
        const fact = factsDb.getById(factId);
        if (!fact) throw new Error(`Fact not found: ${factId}`);
        store.linkFact(issueId, factId);
        console.log(`Linked fact ${factId} to issue ${issueId}.`);
      }),
    );
}
