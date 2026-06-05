/**
 * Orchestrator for corrections and pipeline CLI registration (split modules).
 */
import type { Chainable } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";
import { registerManageConfigCli } from "./register-config-cli.js";
import { registerManageCorrections } from "./register-corrections.js";
import { registerManageReflectionPipeline } from "./register-reflection-pipeline.js";

export { runVerboseFollowUp } from "./dream-cycle-followup.js";
export type { FollowUpProgressSupplier, RunVerboseFollowUpOptions } from "./dream-cycle-followup.js";

export function registerManageCorrectionsAndPipeline(mem: Chainable, b: ManageBindings): void {
  registerManageCorrections(mem, b);
  registerManageConfigCli(mem, b);
  registerManageReflectionPipeline(mem, b, { onlyIngest: true });
}
