/**
 * Issue Tool Registrations — Issue #137
 *
 * Tools for creating, updating, listing, searching, and linking issues
 * through their lifecycle (open → diagnosed → fix-attempted → resolved → verified).
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../utils/string-enum.js";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";

import type { IssueStore } from "../backends/issue-store.js";
import type { IssueStatus, IssueSeverity } from "../types/issue-types.js";
import type { HybridMemoryConfig } from "../config.js";
import { isCompactVerbosity } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";

const ISSUE_STATUSES = ["open", "diagnosed", "fix-attempted", "resolved", "verified", "wont-fix"] as const;

const ISSUE_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export interface IssueToolsContext {
  issueStore: IssueStore;
  /** Optional config for verbosity-aware output (Issue #282). */
  cfg?: Pick<HybridMemoryConfig, "verbosity">;
}

export function registerIssueTools(ctx: IssueToolsContext, api: ClawdbotPluginApi): void {
  const { issueStore } = ctx;
  const verbosity = ctx.cfg?.verbosity ?? "normal";

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

        try {
          const issue = issueStore.create({ title, symptoms, severity, tags });
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
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "issues",
            operation: "issue-create",
            phase: "runtime",
          });
          throw err;
        }
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

        try {
          let issue;
          if (status) {
            // Use transition() to validate state machine
            issue = issueStore.transition(id, status, { rootCause, fix, rollback, symptoms });
          } else {
            issue = issueStore.update(id, { rootCause, fix, rollback, symptoms });
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
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "issues",
            operation: "issue-update",
            phase: "runtime",
          });
          throw err;
        }
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
        const { status, severity, tags, limit } = params as {
          status?: IssueStatus[];
          severity?: string[];
          tags?: string[];
          limit?: number;
        };

        try {
          const issues = issueStore.list({ status, severity, tags, limit });
          const summary = issues
            .map((i) => `[${i.id.slice(0, 8)}] ${i.title} — ${i.status} (${i.severity})`)
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: issues.length === 0 ? "No issues found." : `${issues.length} issue(s):\n${summary}`,
              },
            ],
            details: issues,
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "issues",
            operation: "issue-list",
            phase: "runtime",
          });
          throw err;
        }
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

        try {
          const issues = issueStore.search(query);
          const summary = issues
            .map((i) => `[${i.id.slice(0, 8)}] ${i.title} — ${i.status} (${i.severity})`)
            .join("\n");

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
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "issues",
            operation: "issue-search",
            phase: "runtime",
          });
          throw err;
        }
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

        try {
          issueStore.linkFact(issueId, factId);
          return {
            content: [
              {
                type: "text",
                text: `Linked fact ${factId} to issue ${issueId}.`,
              },
            ],
            details: { issueId, factId },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "issues",
            operation: "issue-link-fact",
            phase: "runtime",
          });
          throw err;
        }
      },
    },
    { name: "memory_issue_link_fact" },
  );
}
