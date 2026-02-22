/**
 * Persona Proposals Tools
 * Tools for proposing and managing changes to identity files (SOUL.md, IDENTITY.md, USER.md)
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROPOSAL_STATUSES, type HybridMemoryConfig } from "../config.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import { SECONDS_PER_DAY } from "../utils/constants.js";
import { capturePluginError } from "../services/error-reporter.js";

export interface PluginContext {
  proposalsDb?: ProposalsDB;
  cfg: HybridMemoryConfig;
  resolvedSqlitePath: string;
}

/**
 * Register persona proposal tools (persona_propose, persona_proposals_list)
 * Only registers if cfg.personaProposals.enabled && proposalsDb is available
 */
export function registerPersonaTools(ctx: PluginContext, api: ClawdbotPluginApi) {
  const { proposalsDb, cfg, resolvedSqlitePath } = ctx;

  // Only register if persona proposals are enabled and database is available
  if (!cfg.personaProposals.enabled || !proposalsDb) {
    return;
  }

  // Shared helper: audit trail logging (used by both tools and CLI commands)
  const auditProposal = async (
    action: string,
    proposalId: string,
    details?: any,
    logger?: { warn?: (msg: string) => void; error?: (msg: string) => void }
  ) => {
    const auditDir = join(dirname(resolvedSqlitePath), "decisions");
    await mkdir(auditDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      action,
      proposalId,
      ...details,
    };
    const auditPath = join(auditDir, `proposal-${proposalId}.jsonl`);
    try {
      await writeFile(auditPath, JSON.stringify(entry) + "\n", { flag: "a" });
    } catch (err) {
      const msg = `Audit log write failed: ${err}`;
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: 'persona-proposal-audit',
        subsystem: 'proposals',
        proposalId,
      });
      if (logger?.warn) {
        logger.warn(`memory-hybrid: ${msg}`);
      } else if (logger?.error) {
        logger.error(msg);
      }
    }
  };

  // Helper: rate limiting check
  const checkRateLimit = (): { allowed: boolean; count: number; limit: number } => {
    const weekInDays = 7;
    const count = proposalsDb!.countRecentProposals(weekInDays);
    const limit = cfg.personaProposals.maxProposalsPerWeek;
    return { allowed: count < limit, count, limit };
  };

  api.registerTool(
    {
      name: "persona_propose",
      label: "Propose Persona Change",
      description:
        "Propose a change to identity files (SOUL.md, IDENTITY.md, USER.md) based on observed patterns. Requires human approval before applying. Rate-limited to prevent spam.",
      parameters: Type.Object({
        targetFile: stringEnum(cfg.personaProposals.allowedFiles),
        title: Type.String({
          description: "Short title for the proposal (e.g., 'Add tone-matching guidance')",
        }),
        observation: Type.String({
          description: "What pattern or behavior you observed (e.g., 'Over ~50 interactions, user responds better to bullet points')",
        }),
        suggestedChange: Type.String({
          description: "The specific change to make to the file (be precise about location and wording)",
        }),
        confidence: Type.Number({
          description: "Confidence score 0-1 (must be >= minConfidence from config)",
          minimum: 0,
          maximum: 1,
        }),
        evidenceSessions: Type.Array(Type.String(), {
          description: "List of session IDs or references that support this proposal",
        }),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const {
          targetFile,
          title,
          observation,
          suggestedChange,
          confidence,
          evidenceSessions,
        } = params as {
          targetFile: string;
          title: string;
          observation: string;
          suggestedChange: string;
          confidence: number;
          evidenceSessions: string[];
        };

        // Field length validation (prevent database bloat and file corruption)
        const MAX_TITLE_LENGTH = 200;
        const MAX_OBSERVATION_LENGTH = 5000;
        const MAX_SUGGESTED_CHANGE_LENGTH = 10000;

        if (title.length > MAX_TITLE_LENGTH) {
          return {
            content: [
              {
                type: "text",
                text: `Title too long: ${title.length} chars (max: ${MAX_TITLE_LENGTH})`,
              },
            ],
            details: { error: "title_too_long", length: title.length, max: MAX_TITLE_LENGTH },
          };
        }

        if (observation.length > MAX_OBSERVATION_LENGTH) {
          return {
            content: [
              {
                type: "text",
                text: `Observation too long: ${observation.length} chars (max: ${MAX_OBSERVATION_LENGTH})`,
              },
            ],
            details: { error: "observation_too_long", length: observation.length, max: MAX_OBSERVATION_LENGTH },
          };
        }

        if (suggestedChange.length > MAX_SUGGESTED_CHANGE_LENGTH) {
          return {
            content: [
              {
                type: "text",
                text: `Suggested change too long: ${suggestedChange.length} chars (max: ${MAX_SUGGESTED_CHANGE_LENGTH})`,
              },
            ],
            details: { error: "suggested_change_too_long", length: suggestedChange.length, max: MAX_SUGGESTED_CHANGE_LENGTH },
          };
        }

        // Rate limiting
        const rateCheck = checkRateLimit();
        if (!rateCheck.allowed) {
          return {
            content: [
              {
                type: "text",
                text: `Rate limit exceeded: ${rateCheck.count}/${rateCheck.limit} proposals this week. Try again later.`,
              },
            ],
            details: { error: "rate_limit_exceeded", ...rateCheck },
          };
        }

        // Confidence check
        if (confidence < cfg.personaProposals.minConfidence) {
          return {
            content: [
              {
                type: "text",
                text: `Confidence ${confidence} is below minimum ${cfg.personaProposals.minConfidence}. Gather more evidence before proposing.`,
              },
            ],
            details: { error: "confidence_too_low", confidence, minRequired: cfg.personaProposals.minConfidence },
          };
        }

        // Evidence validation: check count and content quality
        if (evidenceSessions.length < cfg.personaProposals.minSessionEvidence) {
          return {
            content: [
              {
                type: "text",
                text: `Need at least ${cfg.personaProposals.minSessionEvidence} session evidence (provided: ${evidenceSessions.length})`,
              },
            ],
            details: { error: "insufficient_evidence", provided: evidenceSessions.length, minRequired: cfg.personaProposals.minSessionEvidence },
          };
        }

        // Validate evidence session content (non-empty, unique)
        const invalidSessions = evidenceSessions.filter(s => typeof s !== "string" || s.trim().length === 0);
        if (invalidSessions.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `Evidence sessions must be non-empty strings. Found ${invalidSessions.length} invalid entries.`,
              },
            ],
            details: { error: "invalid_evidence_sessions", invalidCount: invalidSessions.length },
          };
        }

        // Check for duplicate evidence sessions (without trimming to preserve exact matches)
        const uniqueSessions = new Set(evidenceSessions);
        if (uniqueSessions.size !== evidenceSessions.length) {
          return {
            content: [
              {
                type: "text",
                text: `Evidence sessions must be unique. Found ${evidenceSessions.length - uniqueSessions.size} duplicate(s).`,
              },
            ],
            details: { error: "duplicate_evidence_sessions", duplicateCount: evidenceSessions.length - uniqueSessions.size },
          };
        }

        // Calculate expiry
        const expiresAt = cfg.personaProposals.proposalTTLDays > 0
          ? Math.floor(Date.now() / 1000) + cfg.personaProposals.proposalTTLDays * 24 * 3600
          : null;

        // Create proposal
        const proposal = proposalsDb!.create({
          targetFile,
          title,
          observation,
          suggestedChange,
          confidence,
          evidenceSessions,
          expiresAt,
        });

        await auditProposal("created", proposal.id, {
          targetFile,
          title,
          confidence,
          evidenceCount: evidenceSessions.length,
        }, api.logger);

        api.logger.info(`memory-hybrid: persona proposal created — ${proposal.id} (${title})`);

        return {
          content: [
            {
              type: "text",
              text: `Proposal created: ${proposal.id}\nTitle: ${title}\nTarget: ${targetFile}\nStatus: pending\n\nAwaiting human review. Use persona_proposals_list to view all pending proposals.`,
            },
          ],
          details: { proposalId: proposal.id, status: "pending", expiresAt: proposal.expiresAt },
        };
      },
    },
    { name: "persona_propose" },
  );

  api.registerTool(
    {
      name: "persona_proposals_list",
      label: "List Persona Proposals",
      description:
        "List all persona proposals, optionally filtered by status (pending/approved/rejected/applied) or target file.",
      parameters: Type.Object({
        status: Type.Optional(stringEnum(PROPOSAL_STATUSES)),
        targetFile: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const { status, targetFile } = params as { status?: string; targetFile?: string };

        const proposals = proposalsDb!.list({ status, targetFile });

        if (proposals.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No proposals found matching filters.",
              },
            ],
            details: { count: 0, filters: { status, targetFile } },
          };
        }

        const lines = proposals.map((p) => {
          const age = Math.floor((Date.now() / 1000 - p.createdAt) / SECONDS_PER_DAY);
          const expires = p.expiresAt ? Math.floor((p.expiresAt - Date.now() / 1000) / SECONDS_PER_DAY) : null;
          return `[${p.status.toUpperCase()}] ${p.id}\n  Title: ${p.title}\n  Target: ${p.targetFile}\n  Confidence: ${p.confidence}\n  Evidence: ${p.evidenceSessions.length} sessions\n  Age: ${age}d${expires !== null ? `, expires in ${expires}d` : ""}\n  Observation: ${p.observation.length > 120 ? p.observation.slice(0, 120) + "..." : p.observation}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `Found ${proposals.length} proposal(s):\n\n${lines.join("\n\n")}`,
            },
          ],
          details: { count: proposals.length, proposals: proposals.map(p => ({ id: p.id, status: p.status, title: p.title, targetFile: p.targetFile })) },
        };
      },
    },
    { name: "persona_proposals_list" },
  );
}
