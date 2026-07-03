/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import type { Chainable } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";
import { registerManageStorageEntitiesDecay } from "./register-storage-entities-decay.js";
import { registerManageStorageGraphAudit } from "./register-storage-graph-audit.js";
import { registerContactsCommands } from "./register-contacts.js";
export {
  IMPLICIT_FEEDBACK_HISTOGRAM_SAMPLE_CAP,
  recordStorageGrowthSample,
  buildAuditHealthReport,
} from "./storage-stats-helpers.js";
export { buildAuditFailureArtifact, buildAuditHealthExitInfo } from "../../../services/audit-health-exit-info.js";

export function registerManageStorageAndStats(mem: Chainable, b: ManageBindings): void {
  registerManageStorageEntitiesDecay(mem, b);
  registerManageStorageGraphAudit(mem, b);
  registerContactsCommands(mem, b);
}
