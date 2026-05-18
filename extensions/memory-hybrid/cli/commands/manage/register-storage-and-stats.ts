/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import type { Chainable, } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";
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
