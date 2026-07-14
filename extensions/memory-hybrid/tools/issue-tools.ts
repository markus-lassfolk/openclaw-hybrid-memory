/**
 * Issue Tool Registrations — Issue #137
 *
 * Tools for creating, updating, listing, searching, and linking issues
 * through their lifecycle (open → diagnosed → fix-attempted → resolved → verified).
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { stringEnum } from "../utils/typebox.js";

import type { IssueStore } from "../backends/issue-store.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { isCompactVerbosity } from "../config.js";
import type { IssueSeverity, IssueStatus } from "../types/issue-types.js";
import { withErrorTracking } from "../utils/error-tracking.js";
import { autoLinkIssueToFacts } from "../services/issue-fact-correlation.js";
import type { BuildToolScopeFilterFn } from "../api/memory-plugin-api.js";

const ISSUE_STATUSES = ["open", "diagnosed", "fix-attempted", "resolved", "verified", "wont-fix"] as const;

const ISSUE_SEVERITIES = ["low", "medium", "high", "critical"] as const;

interface IssueToolsContext {
  issueStore: IssueStore;
  factsDb?: FactsDB | null;
  /** Optional config for verbosity-aware output (Issue #282). */
  cfg?: Pick<HybridMemoryConfig, "verbosity" | "multiAgent" | "autoRecall">;
  currentAgentIdRef?: { value: string | null };
  buildToolScopeFilter?: BuildToolScopeFilterFn;
}

export function registerIssueTools(ctx: IssueToolsContext, api: ClawdbotPluginApi): void {
  const { issueStore, factsDb, currentAgentIdRef, buildToolScopeFilter } = ctx;
  const verbosity = ctx.cfg?.verbosity ?? "normal";

  // SECURITY: issues are global (unscoped) records, but the facts auto-linked into them are not
  // — without this, memory_issue_create/update's auto-link search and memory_issue_link_fact
  // could tie another tenant's fact into issue.relatedFacts (disclosed back via
  // memory_issue_list/get), the same recurring "missing scopeFilter" gap fixed elsewhere in this
  // codebase. Falls back to no restriction only when this context predates scope wiring (tests).
  const resolveScopeFilter = () =>
    buildToolScopeFilter && ctx.cfg ? buildToolScopeFilter({}, currentAgentIdRef?.value ?? null, ctx.cfg) : undefined;

  const maybeAutoLink = (issue: import("../types/issue-types.js").Issue): void => {
    if (!factsDb) return;
    try {
      autoLinkIssueToFacts(issue, factsDb, issueStore, { scopeFilter: resolveScopeFilter() });
    } catch {
      /* non-fatal */
    }
  };

  // -------------------------------------------------------------------------
  // memory_issue_create
  // -------------------------------------------------------------------------
  api.registerTool(
    {
      name: "memory_issue_create",
      label: "Create Issue",
      description:
        "Create a new tracked issue. Use when a problem is detected that needs structured lifecycle tracking (open → diagnosed → fix-attempted → resolved → verified).",
      parameters: Type.Object({
        title: Type.String({ description: "Short descriptive title for the issue" }),
        symptoms: Type.Array(Type.String(), {
          description: "Observable symptoms or error messages",
        }),
        severity: Type.Optional(stringEnum(ISSUE_SEVERITIES as unknown as readonly string[])),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags for categorization" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const { title, symptoms, severity, tags } = params as {
          title: string;
          symptoms: string[];
          severity?: IssueSeverity;
          tags?: string[];
        };

        const issue = withErrorTracking(() => issueStore.create({ title, symptoms, severity, tags }), {
          subsystem: "issues",
          operation: "issue-create",
          phase: "runtime",
        })();
        maybeAutoLink(issue);
        const createText = isCompactVerbosity(verbosity)
          ? `Issue: ${issue.id}.`
          : `Created issue "${issue.title}" [${issue.id}] (status: ${issue.status}, severity: ${issue.severity})`;
        return {
          content: [
            {
              type: "text",
              text: createText,
            },
          ],
          details: issue,
        };
      },
    },
    { name: "memory_issue_create" },
  );

  // -------------------------------------------------------------------------
  // memory_issue_update
  // -------------------------------------------------------------------------
  api.registerTool(
    {
      name: "memory_issue_update",
      label: "Update Issue",
      description:
        "Update an issue's fields or advance its status through the lifecycle. Status changes validate allowed transitions. Setting status to 'resolved' auto-sets resolvedAt; 'verified' auto-sets verifiedAt.",
      parameters: Type.Object({
        id: Type.String({ description: "Issue ID to update" }),
        status: Type.Optional(stringEnum(ISSUE_STATUSES as unknown as readonly string[])),
        rootCause: Type.Optional(Type.String({ description: "Root cause diagnosis" })),
        fix: Type.Optional(Type.String({ description: "Description of the applied fix" })),
        rollback: Type.Optional(Type.String({ description: "Rollback procedure if fix fails" })),
        symptoms: Type.Optional(Type.Array(Type.String(), { description: "Updated list of symptoms" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const { id, status, rootCause, fix, rollback, symptoms } = params as {
          id: string;
          status?: IssueStatus;
          rootCause?: string;
          fix?: string;
          rollback?: string;
          symptoms?: string[];
        };

        const issue = withErrorTracking(
          () => {
            // Use transition() to validate state machine
            if (status) {
              return issueStore.transition(id, status, { rootCause, fix, rollback, symptoms });
            }
            return issueStore.update(id, { rootCause, fix, rollback, symptoms });
          },
          {
            subsystem: "issues",
            operation: "issue-update",
            phase: "runtime",
          },
        )();

        if (rootCause !== undefined || fix !== undefined || symptoms !== undefined) {
          maybeAutoLink(issue);
        }

        const updateText = isCompactVerbosity(verbosity)
          ? `Issue ${issue.id}: ${issue.status}.`
          : `Updated issue "${issue.title}" [${issue.id}] (status: ${issue.status})`;
        return {
          content: [
            {
              type: "text",
              text: updateText,
            },
          ],
          details: issue,
        };
      },
    },
    { name: "memory_issue_update" },
  );

  // -------------------------------------------------------------------------
  // memory_issue_list
  // -------------------------------------------------------------------------
  api.registerTool(
    {
      name: "memory_issue_list",
      label: "List Issues",
      description: "List tracked issues with optional filters by status, severity, and tags.",
      parameters: Type.Object({
        status: Type.Optional(
          Type.Array(stringEnum(ISSUE_STATUSES as unknown as readonly string[]), {
            description: "Filter by status values",
          }),
        ),
        severity: Type.Optional(
          Type.Array(stringEnum(ISSUE_SEVERITIES as unknown as readonly string[]), {
            description: "Filter by severity values",
          }),
        ),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags (any match)" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 50)" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const {
          status,
          severity,
          tags,
          limit: limitRaw,
        } = params as {
          status?: IssueStatus[];
          severity?: string[];
          tags?: string[];
          limit?: number;
        };
        // IssueStore.list() only appends a SQL LIMIT clause when `limit > 0` -- omitting the
        // param (the documented default path) or passing 0/negative returns the entire issues
        // table unbounded instead of the documented "default: 50" cap, the same
        // non-positive-limit-defeats-SQL-LIMIT pattern already fixed on sibling tools
        // (memory_search_episodes, fact-mutation-gateway). A non-positive value is treated the
        // same as "not provided" (falls back to the default) rather than clamped up to 1, which
        // would silently turn an accidental 0 into a near-useless single-row result.
        const limit =
          typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
            ? Math.max(1, Math.min(500, Math.floor(limitRaw)))
            : 50;

        const issues = withErrorTracking(() => issueStore.list({ status, severity, tags, limit }), {
          subsystem: "issues",
          operation: "issue-list",
          phase: "runtime",
        })();
        const summary = issues.map((i) => `[${i.id.slice(0, 8)}] ${i.title} — ${i.status} (${i.severity})`).join("\n");

        return {
          content: [
            {
              type: "text",
              text: issues.length === 0 ? "No issues found." : `${issues.length} issue(s):\n${summary}`,
            },
          ],
          details: issues,
        };
      },
    },
    { name: "memory_issue_list" },
  );

  // -------------------------------------------------------------------------
  // memory_issue_search
  // -------------------------------------------------------------------------
  api.registerTool(
    {
      name: "memory_issue_search",
      label: "Search Issues",
      description: "Search issues by title and symptoms using LIKE-based text matching.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query to match against issue title and symptoms" }),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const { query } = params as { query: string };

        const issues = withErrorTracking(() => issueStore.search(query), {
          subsystem: "issues",
          operation: "issue-search",
          phase: "runtime",
        })();
        const summary = issues.map((i) => `[${i.id.slice(0, 8)}] ${i.title} — ${i.status} (${i.severity})`).join("\n");

        return {
          content: [
            {
              type: "text",
              text:
                issues.length === 0
                  ? `No issues found for query: "${query}"`
                  : `${issues.length} issue(s) matching "${query}":\n${summary}`,
            },
          ],
          details: issues,
        };
      },
    },
    { name: "memory_issue_search" },
  );

  // -------------------------------------------------------------------------
  // memory_issue_link_fact
  // -------------------------------------------------------------------------
  api.registerTool(
    {
      name: "memory_issue_link_fact",
      label: "Link Fact to Issue",
      description:
        "Associate a memory fact with an issue for cross-referencing problem context with supporting knowledge.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue ID" }),
        factId: Type.String({ description: "Fact ID to link to the issue" }),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const { issueId, factId } = params as { issueId: string; factId: string };

        if (factsDb) {
          // SECURITY: verify the fact exists and is in the caller's scope before linking it —
          // otherwise a caller could tie another tenant's fact into this issue's relatedFacts
          // (mirrors memory_link's guard in graph-tools.ts).
          const fact = factsDb.getById(factId, { scopeFilter: resolveScopeFilter() });
          if (!fact) {
            return {
              content: [{ type: "text", text: `Fact not found: ${factId}` }],
              details: { error: "fact_not_found", id: factId },
            };
          }
        }

        withErrorTracking(() => issueStore.linkFact(issueId, factId), {
          subsystem: "issues",
          operation: "issue-link-fact",
          phase: "runtime",
        })();
        if (factsDb) {
          const issue = issueStore.get(issueId);
          if (issue) maybeAutoLink(issue);
        }
        return {
          content: [
            {
              type: "text",
              text: `Linked fact ${factId} to issue ${issueId}.`,
            },
          ],
          details: { issueId, factId },
        };
      },
    },
    { name: "memory_issue_link_fact" },
  );
}
