/**
 * Verification Tool Registrations
 *
 * Tool definitions for managing verified facts (Issue #162).
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";

import type { FactsDB } from "../backends/facts-db.js";
import type { VerificationStore } from "../services/verification-store.js";
import { VerificationError } from "../services/verification-store.js";

export interface PluginContext {
  factsDb: FactsDB;
  verificationStore: VerificationStore;
}

/**
 * Register verification-related tools with the plugin API.
 *
 * This includes: memory_verify, memory_verified_list, memory_verification_status.
 */
export function registerVerificationTools(ctx: PluginContext, api: ClawdbotPluginApi): void {
  const { factsDb, verificationStore } = ctx;

  api.registerTool(
    {
      name: "memory_verify",
      label: "Memory Verify",
      description: "Mark a fact as verified/critical and store it in the verification store.",
      parameters: Type.Object({
        factId: Type.String({ description: "ID of the fact to verify" }),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const { factId } = params as { factId: string };
        const fact = factsDb.getById(factId);
        if (!fact) {
          return {
            content: [{ type: "text", text: `Fact not found: ${factId}` }],
            details: { error: "not_found", id: factId },
          };
        }
        try {
          const existing = verificationStore.getVerified(factId);
          if (existing) {
            return {
              content: [{ type: "text", text: `Fact ${factId} is already verified (version ${existing.version}).` }],
              details: { status: "already_verified", id: factId, version: existing.version },
            };
          }
        } catch (err) {
          return {
            content: [{ type: "text", text: `Verification status check failed for ${factId}: ${err}` }],
            details: { error: "verification_status_failed", id: factId },
          };
        }
        try {
          const verifiedId = verificationStore.verify(factId, fact.text, "agent");
          return {
            content: [{ type: "text", text: `Verified fact ${factId} (verification id: ${verifiedId}).` }],
            details: { status: "verified", id: factId, verificationId: verifiedId },
          };
        } catch (err) {
          if (err instanceof VerificationError) {
            return {
              content: [{ type: "text", text: `Verification failed for ${factId}: ${err.message}` }],
              details: { error: "verification_failed", id: factId },
            };
          }
          return {
            content: [{ type: "text", text: `Verification failed for ${factId}: ${err}` }],
            details: { error: "verification_failed", id: factId },
          };
        }
      },
    },
    { name: "memory_verify" },
  );

  api.registerTool(
    {
      name: "memory_verified_list",
      label: "Verified Facts List",
      description: "List all verified facts with their latest verification metadata.",
      parameters: Type.Object({}),
      async execute() {
        const verified = verificationStore.listLatestVerified();
        if (verified.length === 0) {
          return {
            content: [{ type: "text", text: "No verified facts found." }],
            details: { count: 0 },
          };
        }
        const lines = verified.map((vf) => {
          const next = vf.nextVerification ? ` next=${vf.nextVerification}` : "";
          return `- ${vf.factId} (v${vf.version}) verified_at=${vf.verifiedAt}${next}: ${vf.canonicalText.slice(0, 120)}${vf.canonicalText.length > 120 ? "…" : ""}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { count: verified.length },
        };
      },
    },
    { name: "memory_verified_list" },
  );

  api.registerTool(
    {
      name: "memory_verification_status",
      label: "Verification Status",
      description: "Check whether a specific fact is verified and return its status.",
      parameters: Type.Object({
        factId: Type.String({ description: "ID of the fact to check" }),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const { factId } = params as { factId: string };
        try {
          const verified = verificationStore.getVerified(factId);
          if (!verified) {
            return {
              content: [{ type: "text", text: `Fact ${factId} is not verified.` }],
              details: { status: "not_verified", id: factId },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Fact ${factId} is verified (v${verified.version}), verified_at=${verified.verifiedAt}.`,
              },
            ],
            details: {
              status: "verified",
              id: factId,
              verifiedAt: verified.verifiedAt,
              verifiedBy: verified.verifiedBy,
              nextVerification: verified.nextVerification,
              version: verified.version,
            },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Verification status check failed for ${factId}: ${err}` }],
            details: { error: "verification_status_failed", id: factId },
          };
        }
      },
    },
    { name: "memory_verification_status" },
  );
}
