import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type VectorLifecycleAuditEvent = {
  event:
    | "reindex_started"
    | "reindex_progress"
    | "reindex_completed"
    | "reindex_aborted"
    | "reconcile_completed"
    | "repair_vectors_completed";
  ts: string;
  details: Record<string, unknown>;
};

export function getVectorLifecycleAuditPath(resolvedSqlitePath: string): string {
  return join(dirname(resolvedSqlitePath), ".vector_lifecycle_audit.jsonl");
}

export function appendVectorLifecycleAuditEvent(resolvedSqlitePath: string, event: VectorLifecycleAuditEvent): void {
  try {
    const path = getVectorLifecycleAuditPath(resolvedSqlitePath);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf-8");
  } catch {
    // Best-effort observability must not make otherwise safe vector lifecycle operations fail.
  }
}
