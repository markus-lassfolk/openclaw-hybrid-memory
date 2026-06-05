/**
 * Rollback metadata for governed proposal applies (OpenClaw integration plan Phase 1).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "../utils/atomic-write.js";

export type ProposalRollbackRecord = {
  proposalId: string;
  proposalType: string;
  targetPath: string;
  originalHash: string;
  originalContent: string;
  /** Content hash immediately after apply — used to detect post-apply edits before undo. */
  appliedHash?: string;
  appliedAt: string;
  changeType?: "append" | "replace";
};

function rollbackDir(resolvedSqlitePath: string): string {
  return join(dirname(resolvedSqlitePath), "proposal-rollbacks");
}

function rollbackPath(resolvedSqlitePath: string, proposalId: string): string {
  const safeId = proposalId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return join(rollbackDir(resolvedSqlitePath), `${safeId}.json`);
}

export function writeProposalRollback(
  resolvedSqlitePath: string,
  record: ProposalRollbackRecord,
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const dir = rollbackDir(resolvedSqlitePath);
    mkdirSync(dir, { recursive: true });
    const path = rollbackPath(resolvedSqlitePath, record.proposalId);
    atomicWriteFile(path, JSON.stringify(record, null, 2));
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function readProposalRollback(resolvedSqlitePath: string, proposalId: string): ProposalRollbackRecord | null {
  const path = rollbackPath(resolvedSqlitePath, proposalId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ProposalRollbackRecord;
  } catch {
    return null;
  }
}

export function deleteProposalRollback(resolvedSqlitePath: string, proposalId: string): void {
  const path = rollbackPath(resolvedSqlitePath, proposalId);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // Non-fatal cleanup failure.
  }
}

export function undoProposalRollback(
  resolvedSqlitePath: string,
  proposalId: string,
): { ok: true; targetPath: string } | { ok: false; error: string } {
  const record = readProposalRollback(resolvedSqlitePath, proposalId);
  if (!record) {
    return { ok: false, error: `No rollback metadata found for proposal ${proposalId}` };
  }
  try {
    if (existsSync(record.targetPath)) {
      const current = readFileSync(record.targetPath, "utf-8");
      const currentHash = createHash("sha256").update(current).digest("hex");
      const expectedHash = record.appliedHash ?? record.originalHash;
      if (currentHash !== expectedHash) {
        return {
          ok: false,
          error: `Target file changed since apply (current hash ${currentHash.slice(0, 8)}…); undo aborted to avoid data loss`,
        };
      }
    }
    mkdirSync(dirname(record.targetPath), { recursive: true });
    atomicWriteFile(record.targetPath, record.originalContent);
    return { ok: true, targetPath: record.targetPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Legacy backup path helper — kept for audit compatibility. */
export function writeLegacyBackupFile(targetPath: string, originalContent: string): string {
  const backupPath = `${targetPath}.backup-${Date.now()}`;
  writeFileSync(backupPath, originalContent);
  return backupPath;
}
