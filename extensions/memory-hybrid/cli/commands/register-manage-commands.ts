/**
 * CLI registration for management commands — thin orchestrator (Issue #955).
 */
import type { ManageContext } from "../context.js";
import type { Chainable } from "../shared.js";
import { buildManageBindings } from "./manage/bindings.js";
import { registerManageAgentsAuditRunall } from "./manage/register-agents-audit-runall.js";
import { registerBackfillMaintenanceCommands } from "./manage/register-backfill-maintenance.js";
import { registerManageBudgetAndProposals } from "./manage/register-budget-proposals.js";
import { registerManageContacts } from "./manage/register-contacts.js";
import { registerManageCorrectionsAndPipeline } from "./manage/register-corrections-and-pipeline.js";
import { registerManageCouncil } from "./manage/register-council.js";
import { registerManageCredentialsAndScope } from "./manage/register-credentials-scope.js";
import { registerManageDigest } from "./manage/register-digest.js";
import { registerManageErrorReports } from "./manage/register-error-reports.js";
import { registerManageIssueTools } from "./manage/register-issue-tools.js";
import { registerExpireBySourceCommands, registerLifecycleSyncCommands } from "./manage/register-lifecycle.js";
import { registerManageLinkTools } from "./manage/register-link-tools.js";
import { registerManageProcedureAndLifecycle } from "./manage/register-procedure-lifecycle.js";
import { registerManageProvenanceTools } from "./manage/register-provenance-tools.js";
import { registerManageStorageAndStats } from "./manage/register-storage-and-stats.js";

export function registerManageCommands(mem: Chainable, ctx: ManageContext): void {
  const b = buildManageBindings(ctx);
  registerExpireBySourceCommands(mem, b);
  registerLifecycleSyncCommands(mem, b);
  registerManageAgentsAuditRunall(mem, b);
  registerManageStorageAndStats(mem, b);
  registerManageBudgetAndProposals(mem, b);
  registerManageCorrectionsAndPipeline(mem, b);
  registerManageCredentialsAndScope(mem, b);
  registerManageContacts(mem, b);
  registerManageProcedureAndLifecycle(mem, b);
  registerManageCouncil(mem, b);
  registerManageDigest(mem, b);
  registerManageErrorReports(mem, b);
  registerManageLinkTools(mem, b);
  registerManageIssueTools(mem, b);
  registerManageProvenanceTools(mem, b);
  // Workflow trace QA tools stay flat (not under grouped maintenance backfill).
  registerBackfillMaintenanceCommands(mem, b, { onlyWorkflowQa: true });
}
