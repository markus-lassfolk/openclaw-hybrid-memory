import type OpenAI from "openai";
import type { BuildToolScopeFilterFn, FindSimilarByEmbeddingFn } from "../../api/memory-plugin-api.js";
import type { AuditStore } from "../../backends/audit-store.js";
import type { CredentialsDB } from "../../backends/credentials-db.js";
import type { EdictStore } from "../../backends/edict-store.js";
import type { EventLog } from "../../backends/event-log.js";
import type { FactsDB } from "../../backends/facts-db.js";
import type { NarrativesDB } from "../../backends/narratives-db.js";
import type { VectorDB } from "../../backends/vector-db.js";
import type { WriteAheadLog } from "../../backends/wal.js";
import type { HybridMemoryConfig } from "../../config.js";
import type { PendingLLMWarnings } from "../../services/chat.js";
import type { VariantGenerationQueue } from "../../services/contextual-variants.js";
import type { EmbeddingRegistry } from "../../services/embedding-registry.js";
import type { EmbeddingProvider } from "../../services/embeddings.js";
import type { ProvenanceService } from "../../services/provenance.js";
import type { AliasDB } from "../../services/retrieval-aliases.js";
import type { VerificationStore } from "../../services/verification-store.js";

export type BoundWalWriteFn = (
  operation: "store" | "update",
  data: Record<string, unknown>,
  logger: { warn: (msg: string) => void },
  supersedeTargetId?: string,
) => Promise<string | null>;

export type BoundWalRemoveFn = (id: string, logger: { warn: (msg: string) => void }) => Promise<void>;

/**
 * Maximum number of characters accepted for any scope parameter (userId/agentId/sessionId).
 * Enforced in every tool that accepts these caller-controlled values to prevent memory
 * exhaustion from excessively long strings being forwarded to SQL queries or logged.
 */
const SCOPE_PARAM_MAX_LENGTH = 256;

/**
 * Validate a caller-supplied scope parameter length.
 * Returns `undefined` unchanged so optional parameters remain optional.
 * Throws for oversized values to avoid identity collisions from truncation.
 */
function _sanitizeScopeParam(paramName: "userId" | "agentId" | "sessionId", v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (v.length > SCOPE_PARAM_MAX_LENGTH) {
    throw new Error(`${paramName} must be <= ${SCOPE_PARAM_MAX_LENGTH} characters`);
  }
  return v;
}

export interface MemoryToolsContext {
  factsDb: FactsDB;
  edictStore: EdictStore;
  vectorDb: VectorDB;
  cfg: HybridMemoryConfig;
  aliasDb?: AliasDB | null;
  embeddings: EmbeddingProvider;
  embeddingRegistry?: EmbeddingRegistry | null;
  openai: OpenAI;
  credentialsDb: CredentialsDB | null;
  eventLog: EventLog | null;
  narrativesDb?: NarrativesDB | null;
  provenanceService?: ProvenanceService | null;
  verificationStore?: VerificationStore | null;
  lastProgressiveIndexIds: string[];
  currentAgentIdRef: { value: string | null };
  pendingLLMWarnings: PendingLLMWarnings;
  variantQueue?: VariantGenerationQueue | null;
  buildToolScopeFilter: BuildToolScopeFilterFn;
  wal: WriteAheadLog | null;
  walWrite: BoundWalWriteFn;
  walRemove: BoundWalRemoveFn;
  findSimilarByEmbedding: FindSimilarByEmbeddingFn;
  /** Cross-agent audit trail (Issue #790). */
  auditStore?: AuditStore | null;
}

type LegacyMemoryToolsContext = Omit<
  MemoryToolsContext,
  "buildToolScopeFilter" | "walWrite" | "walRemove" | "findSimilarByEmbedding"
> & {
  wal?: unknown;
};
