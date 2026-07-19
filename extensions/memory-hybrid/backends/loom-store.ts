/**
 * LoomStore — SQLite backend for The Loom (Epic #2150): evidence capsules (#2148),
 * belief graph / claim ledger + live-check contracts (#2151, #2156), open-loop
 * obligations ledger (#2152), drift scout findings (#2146), attention steward
 * overrides (#2153), memory lifecycle audit (#2155), and procedure triage
 * decisions (#2147). One SQLite file, one table per concept, decomposed into
 * `backends/loom/*` modules (cloned from the FactsDB/SerendipityStore pattern).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AttentionOverride, AttentionOverrideAction, AttentionTargetKind } from "../types/attention-types.js";
import type {
  AssertClaimInput,
  Claim,
  ClaimFilter,
  LiveCheckEvent,
  LiveCheckStatus,
  SuggestedLiveCheck,
} from "../types/belief-types.js";
import type { CreateDriftFindingInput, DriftFinding, DriftFindingFilter, DriftStatus } from "../types/drift-types.js";
import type { EvidenceCapsule, EvidenceCapsuleFilter } from "../types/evidence-types.js";
import type { LifecycleAction, LifecycleAuditEntry, LifecycleTargetKind } from "../types/lifecycle-workflow-types.js";
import type {
  CloseOpenLoopInput,
  CreateOpenLoopInput,
  LoopStatus,
  OpenLoop,
  OpenLoopFilter,
} from "../types/open-loop-types.js";
import type { ProcedureTriageDecision, ProcedureTriageDecisionInput } from "../types/procedure-triage-types.js";
import { BaseSqliteStore } from "./base-sqlite-store.js";
import * as attention from "./loom/attention.js";
import * as beliefs from "./loom/beliefs.js";
import * as drift from "./loom/drift.js";
import type { CreateEvidenceCapsuleParams } from "./loom/evidence.js";
import * as evidence from "./loom/evidence.js";
import * as lifecycleAudit from "./loom/lifecycle-audit.js";
import * as openLoops from "./loom/open-loops.js";
import * as procedureTriageStore from "./loom/procedure-triage-store.js";
import { createLoomSchemaV1 } from "./loom/schema.js";
import { readSchemaVersion, runVersionedSchemaMigration } from "./sqlite-schema-meta.js";

const LOOM_STORE_SCHEMA_VERSION = 1;

export class LoomStore extends BaseSqliteStore {
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);
    this.migrate();
  }

  protected getSubsystemName(): string {
    return "loom-store";
  }

  private migrate(): void {
    let v = readSchemaVersion(this.liveDb, "loom");
    while (v < LOOM_STORE_SCHEMA_VERSION) {
      const next = v + 1;
      if (next === 1) {
        runVersionedSchemaMigration(this.liveDb, "loom", next, () => createLoomSchemaV1(this.liveDb));
      }
      v = next;
    }
  }

  // --- Evidence capsules (#2148) --------------------------------------------

  createEvidenceCapsule(params: CreateEvidenceCapsuleParams): EvidenceCapsule {
    return evidence.createEvidenceCapsule(this.liveDb, params);
  }
  getEvidenceCapsule(id: string): EvidenceCapsule | null {
    return evidence.getEvidenceCapsule(this.liveDb, id);
  }
  resolveEvidenceCapsule(idOrPrefix: string): EvidenceCapsule | null {
    return evidence.resolveEvidenceCapsule(this.liveDb, idOrPrefix);
  }
  listEvidenceCapsules(filter?: EvidenceCapsuleFilter): EvidenceCapsule[] {
    return evidence.listEvidenceCapsules(this.liveDb, filter);
  }
  markEvidenceCapsuleVerified(id: string, at?: string): EvidenceCapsule {
    return evidence.markEvidenceCapsuleVerified(this.liveDb, id, at);
  }
  linkEvidenceCapsuleToClaim(id: string, claimId: string): EvidenceCapsule {
    return evidence.linkEvidenceCapsuleToClaim(this.liveDb, id, claimId);
  }
  attachEvidenceCapsule(id: string, patch: { linkedTaskLabel?: string; linkedGoalId?: string }): EvidenceCapsule {
    return evidence.attachEvidenceCapsule(this.liveDb, id, patch);
  }

  // --- Belief graph / claim ledger (#2151) + live checks (#2156) -----------

  assertClaim(input: AssertClaimInput): Claim {
    return beliefs.assertClaim(this.liveDb, input);
  }
  getClaim(id: string): Claim | null {
    return beliefs.getClaim(this.liveDb, id);
  }
  resolveClaim(idOrPrefix: string): Claim | null {
    return beliefs.resolveClaim(this.liveDb, idOrPrefix);
  }
  listClaims(filter?: ClaimFilter): Claim[] {
    return beliefs.listClaims(this.liveDb, filter);
  }
  getBeliefsForEntity(entity: string, includeNonPrimary = false): Claim[] {
    return beliefs.getBeliefsForEntity(this.liveDb, entity, includeNonPrimary);
  }
  verifyClaim(id: string, opts?: { evidenceCapsuleId?: string; confidence?: number; at?: string }): Claim {
    return beliefs.verifyClaim(this.liveDb, id, opts);
  }
  contradictClaim(id: string, withClaimId: string, reason?: string): Claim {
    return beliefs.contradictClaim(this.liveDb, id, withClaimId, reason);
  }
  supersedeClaim(id: string, byClaimId: string): Claim {
    return beliefs.supersedeClaim(this.liveDb, id, byClaimId);
  }
  sweepStaleClaims(staleAfterDays: number, now?: string): number {
    return beliefs.sweepStaleClaims(this.liveDb, staleAfterDays, now);
  }
  requireLiveCheck(id: string, opts: { reason: string; suggestedChecks?: SuggestedLiveCheck[] }): Claim {
    return beliefs.requireLiveCheck(this.liveDb, id, opts);
  }
  satisfyLiveCheck(params: {
    claimId: string;
    evidenceCapsuleId?: string;
    note?: string;
    satisfiedBy?: string;
    ttlHours: number;
  }): LiveCheckEvent {
    return beliefs.satisfyLiveCheck(this.liveDb, params);
  }
  listLiveCheckEvents(claimId: string): LiveCheckEvent[] {
    return beliefs.listLiveCheckEvents(this.liveDb, claimId);
  }
  getLiveCheckStatus(claimId: string, now?: string): LiveCheckStatus {
    return beliefs.getLiveCheckStatus(this.liveDb, claimId, now);
  }
  listUnsatisfiedLiveChecks(now?: string): Claim[] {
    return beliefs.listUnsatisfiedLiveChecks(this.liveDb, now);
  }

  // --- Open-loop obligations ledger (#2152) ---------------------------------

  createOpenLoop(input: CreateOpenLoopInput, opts?: { defaultResurfaceDays?: number }): OpenLoop {
    return openLoops.createOpenLoop(this.liveDb, input, opts);
  }
  getOpenLoop(id: string): OpenLoop | null {
    return openLoops.getOpenLoop(this.liveDb, id);
  }
  resolveOpenLoop(idOrPrefix: string): OpenLoop | null {
    return openLoops.resolveOpenLoop(this.liveDb, idOrPrefix);
  }
  listOpenLoops(filter?: OpenLoopFilter): OpenLoop[] {
    return openLoops.listOpenLoops(this.liveDb, filter);
  }
  updateOpenLoop(id: string, patch: Partial<CreateOpenLoopInput & { status: LoopStatus }>): OpenLoop {
    return openLoops.updateOpenLoop(this.liveDb, id, patch);
  }
  closeOpenLoop(id: string, input?: CloseOpenLoopInput): OpenLoop {
    return openLoops.closeOpenLoop(this.liveDb, id, input);
  }
  listLoopsDueForResurface(now?: string, limit?: number): OpenLoop[] {
    return openLoops.listDueForResurface(this.liveDb, now, limit);
  }
  markLoopResurfaced(id: string, at?: string): void {
    openLoops.markResurfaced(this.liveDb, id, at);
  }

  // --- Drift scout (#2146) ---------------------------------------------------

  createDriftFinding(input: CreateDriftFindingInput): DriftFinding {
    return drift.createDriftFinding(this.liveDb, input);
  }
  getDriftFinding(id: string): DriftFinding | null {
    return drift.getDriftFinding(this.liveDb, id);
  }
  resolveDriftFinding(idOrPrefix: string): DriftFinding | null {
    return drift.resolveDriftFinding(this.liveDb, idOrPrefix);
  }
  listDriftFindings(filter?: DriftFindingFilter): DriftFinding[] {
    return drift.listDriftFindings(this.liveDb, filter);
  }
  findDriftByDedupHash(dedupHash: string): DriftFinding | null {
    return drift.findDriftByDedupHash(this.liveDb, dedupHash);
  }
  updateDriftStatus(
    id: string,
    status: DriftStatus,
    opts?: { snoozedUntil?: string; promotedTo?: string },
  ): DriftFinding {
    return drift.updateDriftStatus(this.liveDb, id, status, opts);
  }

  // --- Attention steward overrides (#2153) -----------------------------------

  setAttentionOverride(input: {
    targetKind: AttentionTargetKind;
    targetId: string;
    action: AttentionOverrideAction;
    reason?: string;
    snoozedUntil?: string;
  }): AttentionOverride {
    return attention.setAttentionOverride(this.liveDb, input);
  }
  listAttentionOverrides(): AttentionOverride[] {
    return attention.listAttentionOverrides(this.liveDb);
  }
  getAttentionOverride(targetKind: AttentionTargetKind, targetId: string): AttentionOverride | null {
    return attention.getAttentionOverride(this.liveDb, targetKind, targetId);
  }

  // --- Memory lifecycle audit (#2155) -----------------------------------------

  recordLifecycleAudit(input: {
    targetKind: LifecycleTargetKind;
    targetId: string;
    action: LifecycleAction;
    reason: string;
    confirmedBy?: string;
    metadata?: Record<string, unknown>;
  }): LifecycleAuditEntry {
    return lifecycleAudit.recordLifecycleAudit(this.liveDb, input);
  }
  listLifecycleAudit(filter?: {
    targetKind?: LifecycleTargetKind;
    targetId?: string;
    limit?: number;
  }): LifecycleAuditEntry[] {
    return lifecycleAudit.listLifecycleAudit(this.liveDb, filter);
  }

  // --- Procedure triage decisions (#2147) -------------------------------------

  recordProcedureTriageDecision(input: ProcedureTriageDecisionInput): ProcedureTriageDecision {
    return procedureTriageStore.recordProcedureTriageDecision(this.liveDb, input);
  }
  getProcedureTriageDecision(clusterId: string): ProcedureTriageDecision | null {
    return procedureTriageStore.getProcedureTriageDecision(this.liveDb, clusterId);
  }
  listProcedureTriageDecisions(): ProcedureTriageDecision[] {
    return procedureTriageStore.listProcedureTriageDecisions(this.liveDb);
  }

  /** @internal Raw DB access for services that need cross-table queries (e.g. attention steward). */
  getRawDb() {
    return this.liveDb;
  }
}
