/**
 * CLI registration for management commands — thin orchestrator (Issue #955).
 */
import type { ManageContext } from "../context.js";
import type { Chainable } from "../shared.js";
import { buildManageBindings } from "./manage/bindings.js";
import { registerManageAgentsAuditRunall } from "./manage/register-agents-audit-runall.js";
import { registerManageBudgetAndProposals } from "./manage/register-budget-proposals.js";
import { registerManageCorrectionsAndPipeline } from "./manage/register-corrections-and-pipeline.js";
import { registerManageCouncil } from "./manage/register-council.js";
import { registerManageCredentialsAndScope } from "./manage/register-credentials-scope.js";
import { registerManageProcedureAndLifecycle } from "./manage/register-procedure-lifecycle.js";
import { registerManageStorageAndStats } from "./manage/register-storage-and-stats.js";

export function registerManageCommands(mem: Chainable, ctx: ManageContext): void {
  const b = buildManageBindings(ctx);
  registerManageAgentsAuditRunall(mem, b);
  registerManageStorageAndStats(mem, b);
  registerManageBudgetAndProposals(mem, b);
  registerManageCorrectionsAndPipeline(mem, b);
  registerManageCredentialsAndScope(mem, b);
  registerManageProcedureAndLifecycle(mem, b);
  registerManageCouncil(mem, b);
}
