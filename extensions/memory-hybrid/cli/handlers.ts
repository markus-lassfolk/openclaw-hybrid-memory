/**
 * CLI Handler Functions — Re-export barrel
 *
 * This module is a thin composition layer. All implementations live in the
 * cmd-* siblings; this file re-exports everything so that existing callers
 * (setup/cli-context.ts, index.ts, tests) continue to work without changes.
 *
 * HandlerContext is defined here (not in a cmd-* file) to keep cmd-* imports
 * clean and avoid circular-dependency concerns.
 */

import type OpenAI from "openai";
import type { CostTracker } from "../backends/cost-tracker.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { EventBus } from "../backends/event-bus.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { IdentityReflectionStore } from "../backends/identity-reflection-store.js";
import type { PersonaStateStore } from "../backends/persona-state-store.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { HybridMemoryConfig, MemoryCategory } from "../config.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { AuditStore } from "../backends/audit-store.js";

/** Shared dependency bag passed to every CLI handler. */
export interface HandlerContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  openai: OpenAI;
  cfg: HybridMemoryConfig;
  credentialsDb: CredentialsDB | null;
  aliasDb: import("../services/retrieval-aliases.js").AliasDB | null;
  wal: WriteAheadLog | null;
  proposalsDb: ProposalsDB | null;
  identityReflectionStore: IdentityReflectionStore | null;
  personaStateStore: PersonaStateStore | null;
  resolvedSqlitePath: string;
  resolvedLancePath: string;
  pluginId: string;
  logger: { info?: (m: string) => void; warn?: (m: string) => void };
  /** Category detection for extract-daily and similar; uses language keywords when set */
  detectCategory: (text: string) => MemoryCategory;
  /** OpenClaw plugin API — used for verify to read gateway config (e.g. models.providers for MiniMax etc.) */
  api?: import("openclaw/plugin-sdk/core").ClawdbotPluginApi;
  /** LLM cost tracker — records per-call token usage (Issue #270). */
  costTracker?: CostTracker | null;
  /** Event Bus for sensor sweep (Issue #236). */
  eventBus?: EventBus | null;
  /** Cross-agent audit log (Issue #790). */
  auditStore?: AuditStore | null;
}

// ---------------------------------------------------------------------------
// Re-export all command implementations from their dedicated modules.
// ---------------------------------------------------------------------------

export * from "./cmd-store.js";
export * from "./cmd-install.js";
export * from "./cmd-verify.js";
export * from "./cmd-distill.js";
export * from "./cmd-extract.js";
export * from "./cmd-backfill.js";
export * from "./cmd-credentials.js";
export * from "./cmd-selfcorrection.js";
export * from "./cmd-feedback.js";
export * from "./cmd-config.js";
export * from "./shared.js";
