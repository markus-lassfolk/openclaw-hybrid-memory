/**
 * Serendipity Protocol tools (Issue #2119).
 *
 * serendipity_record / _list / _decide / _resolve / _digest — bounded proactive
 * findings: record with evidence + dedup, list/triage, recommend an action for
 * the current engagement level, and resolve within guardrails.
 *
 * Distinct from the recall-time `autoRecall.serendipity` slot.
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import type { BuildToolScopeFilterFn } from "../api/memory-plugin-api.js";
import type { IssueStore } from "../backends/issue-store.js";
import { SerendipityStore, serendipityDedupHash } from "../backends/serendipity-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import {
  buildSerendipityDigestReport,
  renderSerendipityDigestMarkdown,
  writeSerendipityDigestOutput,
} from "../services/serendipity-digest.js";
import { decideSerendipityAction } from "../services/serendipity-policy.js";
import { parsePendingDigestSinceDays } from "../services/pending-review-digest.js";
import type { IssueSeverity } from "../types/issue-types.js";
import {
  SERENDIPITY_ADJACENCIES,
  SERENDIPITY_FINDING_TYPES,
  SERENDIPITY_LOAD_REDUCTIONS,
  SERENDIPITY_REVERSIBILITIES,
  SERENDIPITY_RISK_LEVELS,
  SERENDIPITY_SUGGESTED_ACTIONS,
  type CreateSerendipityFindingInput,
  type SerendipityFinding,
  type SerendipityFindingType,
  type SerendipityRiskLevel,
  type SerendipityScopeContext,
  type SerendipityStatus,
  type SerendipitySuggestedAction,
} from "../types/serendipity-types.js";
import { stringEnum } from "../utils/typebox.js";

export interface SerendipityToolsContext {
  serendipityStore: SerendipityStore | null;
  issueStore?: IssueStore | null;
  cfg: HybridMemoryConfig;
  currentAgentIdRef: { value: string | null };
  buildToolScopeFilter: BuildToolScopeFilterFn;
}

const RESOLVE_STATUSES = ["fixed", "filed", "remembered", "proposed", "dismissed", "deferred"] as const;

function riskToSeverity(risk: SerendipityRiskLevel): IssueSeverity {
  return risk; // low|medium|high are shared between the two enums
}

function findingSummary(f: SerendipityFinding): string {
  return `- [${f.status}] ${f.title} (${f.findingType}, risk ${f.riskLevel}, ${f.adjacency}, id: ${f.id.slice(0, 8)})`;
}

export function registerSerendipityTools(ctx: SerendipityToolsContext, api: ClawdbotPluginApi): void {
  const { serendipityStore: store, issueStore, cfg, currentAgentIdRef, buildToolScopeFilter } = ctx;
  const sp = cfg.serendipityProtocol;

  const notEnabled = () => ({
    content: [
      {
        type: "text" as const,
        text: "Serendipity Protocol is disabled. Set serendipityProtocol.enabled: true in plugin config.",
      },
    ],
    details: { error: "serendipity_disabled" },
  });

  const fail = (err: unknown, operation: string) => {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "serendipity", operation });
    return { content: [{ type: "text" as const, text: String(err) }], details: { error: String(err) } };
  };

  const scopeContext = (repo?: string | null): SerendipityScopeContext => {
    const sf = buildToolScopeFilter({}, currentAgentIdRef.value, cfg);
    return {
      userId: sf?.userId ?? null,
      agentId: sf?.agentId ?? null,
      sessionId: sf?.sessionId ?? null,
      repo: repo ?? null,
    };
  };
  const resolveLevel = (repo?: string | null): number =>
    store ? store.resolveLevel(scopeContext(repo), sp.defaultLevel) : sp.defaultLevel;

  // --- serendipity_record ---------------------------------------------------
  api.registerTool(
    {
      name: "serendipity_record",
      label: "Record Serendipity Finding",
      description:
        "Record a bounded proactive finding (adjacent improvement noticed while doing requested work) with evidence and a suggested action. Deduplicates against recent similar findings by repo/entity/type/title.",
      parameters: Type.Object({
        title: Type.String({ description: "Short, specific title for the finding." }),
        description: Type.String({ description: "What was noticed and why it matters." }),
        finding_type: stringEnum(SERENDIPITY_FINDING_TYPES as unknown as readonly string[]),
        suggested_action: Type.Optional(stringEnum(SERENDIPITY_SUGGESTED_ACTIONS as unknown as readonly string[])),
        risk_level: Type.Optional(stringEnum(SERENDIPITY_RISK_LEVELS as unknown as readonly string[])),
        reversibility: Type.Optional(stringEnum(SERENDIPITY_REVERSIBILITIES as unknown as readonly string[])),
        adjacency: Type.Optional(stringEnum(SERENDIPITY_ADJACENCIES as unknown as readonly string[])),
        estimated_human_load_reduction: Type.Optional(
          stringEnum(SERENDIPITY_LOAD_REDUCTIONS as unknown as readonly string[]),
        ),
        confidence: Type.Optional(Type.Number({ description: "0–1 confidence in the finding (default 0.5)." })),
        repo: Type.Optional(Type.String()),
        entity: Type.Optional(Type.String()),
        evidence: Type.Optional(Type.Array(Type.String(), { description: "Concrete evidence lines." })),
        external: Type.Optional(Type.Boolean({ description: "Acting would cause an external side effect." })),
        destructive: Type.Optional(Type.Boolean({ description: "Acting would be destructive." })),
        privacy_sensitive: Type.Optional(Type.Boolean({ description: "Acting touches privacy-sensitive data." })),
        related_facts: Type.Optional(Type.Array(Type.String())),
        related_issues: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!sp.enabled || !store) return notEnabled();
        try {
          const p = params as {
            title: string;
            description: string;
            finding_type: SerendipityFindingType;
            suggested_action?: SerendipitySuggestedAction;
            risk_level?: SerendipityRiskLevel;
            reversibility?: CreateSerendipityFindingInput["reversibility"];
            adjacency?: CreateSerendipityFindingInput["adjacency"];
            estimated_human_load_reduction?: CreateSerendipityFindingInput["estimatedHumanLoadReduction"];
            confidence?: number;
            repo?: string;
            entity?: string;
            evidence?: string[];
            external?: boolean;
            destructive?: boolean;
            privacy_sensitive?: boolean;
            related_facts?: string[];
            related_issues?: string[];
          };
          const evidence = (p.evidence ?? []).filter((e) => typeof e === "string");
          const hash = serendipityDedupHash({
            repo: p.repo,
            entity: p.entity,
            findingType: p.finding_type,
            title: p.title,
          });
          const dup = store.findByDedupHash(hash, sp.dedupWindowDays);
          if (dup) {
            const merged = evidence.length > 0 ? store.mergeEvidence(dup.id, evidence) : dup;
            return {
              content: [
                {
                  type: "text",
                  text: `Duplicate of existing finding ${dup.id.slice(0, 8)} ("${dup.title}") — merged evidence instead of creating a new record.`,
                },
              ],
              details: { deduped: true, id: dup.id, finding: merged },
            };
          }
          const input: CreateSerendipityFindingInput = {
            title: p.title,
            description: p.description,
            findingType: p.finding_type,
            suggestedAction: p.suggested_action,
            riskLevel: p.risk_level,
            reversibility: p.reversibility,
            adjacency: p.adjacency,
            estimatedHumanLoadReduction: p.estimated_human_load_reduction,
            confidence: p.confidence,
            repo: p.repo,
            entity: p.entity,
            evidence,
            external: p.external,
            destructive: p.destructive,
            privacySensitive: p.privacy_sensitive,
            relatedFacts: p.related_facts,
            relatedIssues: p.related_issues,
            sourceSession: scopeContext(p.repo).sessionId ?? undefined,
          };
          const finding = store.create(input, { defaultTtlDays: sp.deferredTtlDays });
          return {
            content: [
              {
                type: "text",
                text: `Recorded finding ${finding.id.slice(0, 8)}: "${finding.title}" (${finding.findingType}). Use serendipity_decide for a recommended action.`,
              },
            ],
            details: { id: finding.id, finding },
          };
        } catch (err) {
          return fail(err, "serendipity_record");
        }
      },
    },
    { name: "serendipity_record" },
  );

  // --- serendipity_list -----------------------------------------------------
  api.registerTool(
    {
      name: "serendipity_list",
      label: "List Serendipity Findings",
      description:
        "List serendipity findings, filtered by status/type/risk/action/repo. Set backlog:true to list only actionable, non-expired deferred findings ranked by urgency and leverage.",
      parameters: Type.Object({
        status: Type.Optional(Type.Array(stringEnum(RESOLVE_STATUSES as unknown as readonly string[]))),
        finding_type: Type.Optional(Type.Array(stringEnum(SERENDIPITY_FINDING_TYPES as unknown as readonly string[]))),
        risk_level: Type.Optional(Type.Array(stringEnum(SERENDIPITY_RISK_LEVELS as unknown as readonly string[]))),
        suggested_action: Type.Optional(
          Type.Array(stringEnum(SERENDIPITY_SUGGESTED_ACTIONS as unknown as readonly string[])),
        ),
        repo: Type.Optional(Type.String()),
        backlog: Type.Optional(Type.Boolean({ description: "Only actionable deferred/observed findings." })),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!sp.enabled || !store) return notEnabled();
        try {
          const p = params as {
            status?: SerendipityStatus[];
            finding_type?: SerendipityFindingType[];
            risk_level?: SerendipityRiskLevel[];
            suggested_action?: SerendipitySuggestedAction[];
            repo?: string;
            backlog?: boolean;
            limit?: number;
          };
          const limitRaw = typeof p.limit === "number" ? Math.floor(p.limit) : 50;
          const limit = limitRaw > 0 ? Math.max(1, Math.min(500, limitRaw)) : 50;
          const findings = p.backlog
            ? store.listActionableDeferred({ level: resolveLevel(p.repo), repo: p.repo, limit })
            : store.list({
                status: p.status,
                findingType: p.finding_type,
                riskLevel: p.risk_level,
                suggestedAction: p.suggested_action,
                repo: p.repo,
                limit,
              });
          if (findings.length === 0) {
            return { content: [{ type: "text", text: "No findings match." }], details: { count: 0, findings: [] } };
          }
          return {
            content: [
              { type: "text", text: `${findings.length} finding(s):\n${findings.map(findingSummary).join("\n")}` },
            ],
            details: { count: findings.length, findings },
          };
        } catch (err) {
          return fail(err, "serendipity_list");
        }
      },
    },
    { name: "serendipity_list" },
  );

  // --- serendipity_decide ---------------------------------------------------
  api.registerTool(
    {
      name: "serendipity_decide",
      label: "Decide Serendipity Action",
      description:
        "Recommend an action for a finding given the current engagement level (fix/file/propose/remember/ask/ignore). Recommends only — it never executes. External/destructive/privacy-sensitive/irreversible always require approval.",
      parameters: Type.Object({
        finding_id: Type.String({ description: "Finding id or short id prefix." }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!sp.enabled || !store) return notEnabled();
        try {
          const findingId = String((params as { finding_id?: string }).finding_id ?? "").trim();
          if (!findingId) {
            return { content: [{ type: "text", text: "Provide finding_id." }], details: { error: "missing_id" } };
          }
          const finding = store.resolve(findingId);
          if (!finding) {
            return { content: [{ type: "text", text: "Finding not found." }], details: { error: "not_found" } };
          }
          const level = resolveLevel(finding.repo);
          const decision = decideSerendipityAction(finding, level);
          return {
            content: [
              {
                type: "text",
                text: `Recommended: ${decision.action} (level ${decision.level}). ${decision.rationale}`,
              },
            ],
            details: { finding_id: finding.id, ...decision },
          };
        } catch (err) {
          return fail(err, "serendipity_decide");
        }
      },
    },
    { name: "serendipity_decide" },
  );

  // --- serendipity_resolve --------------------------------------------------
  api.registerTool(
    {
      name: "serendipity_resolve",
      label: "Resolve Serendipity Finding",
      description:
        "Record the outcome of a finding: fixed/filed/remembered/proposed/dismissed/deferred, with what was done. When status=filed and an issue tracker is available, a linked local issue is created (real GitHub filing stays an approval-gated agent action).",
      parameters: Type.Object({
        finding_id: Type.String({ description: "Finding id or short id prefix." }),
        status: stringEnum(RESOLVE_STATUSES as unknown as readonly string[]),
        action_taken: Type.Optional(Type.String({ description: "What was done (or why deferred/dismissed)." })),
        evidence: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!sp.enabled || !store) return notEnabled();
        try {
          const p = params as {
            finding_id?: string;
            status?: SerendipityStatus;
            action_taken?: string;
            evidence?: string[];
          };
          const findingId = String(p.finding_id ?? "").trim();
          const status = p.status;
          if (!findingId || !status) {
            return {
              content: [{ type: "text", text: "Provide finding_id and status." }],
              details: { error: "missing_args" },
            };
          }
          const finding = store.resolve(findingId);
          if (!finding) {
            return { content: [{ type: "text", text: "Finding not found." }], details: { error: "not_found" } };
          }
          const newEvidence = (p.evidence ?? []).filter((e) => typeof e === "string");
          const mergedEvidence =
            newEvidence.length > 0 ? Array.from(new Set([...finding.evidence, ...newEvidence])) : finding.evidence;

          let createdIssueId: string | undefined;
          if (status === "filed" && issueStore) {
            const issue = issueStore.create({
              title: finding.title,
              symptoms: finding.evidence.length > 0 ? finding.evidence : [finding.description],
              severity: riskToSeverity(finding.riskLevel),
              tags: ["serendipity", finding.findingType],
              metadata: { serendipityFindingId: finding.id },
            });
            createdIssueId = issue.id;
            store.linkRecord(finding.id, "issue", issue.id);
          }

          const updated = store.transition(finding.id, status, {
            actionTaken: p.action_taken,
            evidence: mergedEvidence,
          });
          const issueNote = createdIssueId ? ` Linked local issue ${createdIssueId.slice(0, 8)}.` : "";
          return {
            content: [{ type: "text", text: `Finding ${finding.id.slice(0, 8)} → ${updated.status}.${issueNote}` }],
            details: { finding: updated, issue_id: createdIssueId },
          };
        } catch (err) {
          return fail(err, "serendipity_resolve");
        }
      },
    },
    { name: "serendipity_resolve" },
  );

  // --- serendipity_digest ---------------------------------------------------
  api.registerTool(
    {
      name: "serendipity_digest",
      label: "Serendipity Digest",
      description:
        "Produce a compact, low-noise digest of findings and the actionable deferred backlog (counts, age hygiene, top items with resolve commands).",
      parameters: Type.Object({
        since: Type.Optional(Type.String({ description: 'Lookback window, e.g. "7d", "24h", "2w" (default 7d).' })),
        format: Type.Optional(stringEnum(["md", "json"] as const)),
        out: Type.Optional(Type.String({ description: 'Write to path, or "-" for stdout.' })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!sp.enabled || !store) return notEnabled();
        if (!sp.digest.enabled) {
          return {
            content: [{ type: "text", text: "Serendipity digest is disabled (serendipityProtocol.digest.enabled)." }],
            details: { error: "digest_disabled" },
          };
        }
        try {
          const p = params as { since?: string; format?: "md" | "json"; out?: string };
          const sinceDays = parsePendingDigestSinceDays(p.since ?? "7d");
          // Operator/review view: show the full actionable backlog (level 4).
          const report = buildSerendipityDigestReport({ store, sinceDays, level: 4 });
          if (p.out) {
            writeSerendipityDigestOutput({ report, format: p.format ?? "md", outPath: p.out });
          }
          const text = p.format === "json" ? JSON.stringify(report, null, 2) : renderSerendipityDigestMarkdown(report);
          return { content: [{ type: "text", text }], details: { report } };
        } catch (err) {
          return fail(err, "serendipity_digest");
        }
      },
    },
    { name: "serendipity_digest" },
  );
}
