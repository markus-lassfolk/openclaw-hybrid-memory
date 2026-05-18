/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import type { GraphConnectedStats } from "../../../backends/facts-db/links.js";
import { isValidCategory, vectorDimsForModel } from "../../../config.js";
import { buildAuditHealthExitInfo } from "../../../services/audit-health-exit-info.js";
import { listDumpTypeAliases, runSqliteTableDump } from "../../../services/cli-sql-dump.js";
import { runContextAudit } from "../../../services/context-audit.js";
import { migrateEmbeddings } from "../../../services/embedding-migration.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { recordMaintenanceTimestamp } from "../../../services/maintenance-timestamp.js";
import { repairEventHubs } from "../../../services/event-hub-repair.js";
import { type GraphExpansionStats, expandGraph, resolveGraphHubDegreeCap } from "../../../services/graph-retrieval.js";
import { runMemoryDiagnostics } from "../../../services/memory-diagnostics.js";
import { filterByScope } from "../../../services/merge-results.js";
import { countPendingReviewBacklogs } from "../../../services/pending-review-digest.js";
import { deleteVectorsForFactIds } from "../../../services/vector-maintenance.js";
import { appendVectorLifecycleAuditEvent } from "../../../services/vector-lifecycle-audit.js";
import type { MemoryEntry, ScopeFilter } from "../../../types/memory.js";
import { isEntityStopWord } from "../../../utils/entity-stopwords.js";
import { getEnv } from "../../../utils/env-manager.js";
import { SQL_IMPLICIT_TRAJECTORY_LESSON_FILTER } from "../../cmd-feedback.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
import { type Chainable, approxIntervalMs, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";
import { registerEntityLifecycleCommands } from "./register-lifecycle.js";
import { registerManageStorageMaintenance } from "./register-storage-maintenance.js";
import { registerManageStorageEntitiesDecay } from "./register-storage-entities-decay.js";
import { registerManageStorageGraphAudit } from "./register-storage-graph-audit.js";
export {
  IMPLICIT_FEEDBACK_HISTOGRAM_SAMPLE_CAP,
  recordStorageGrowthSample,
  buildAuditHealthReport,
} from "./storage-stats-helpers.js";

export function registerManageStorageAndStats(mem: Chainable, b: ManageBindings): void {
  registerManageStorageMaintenance(mem, b);
  registerManageStorageEntitiesDecay(mem, b);
  registerManageStorageGraphAudit(mem, b);
}
