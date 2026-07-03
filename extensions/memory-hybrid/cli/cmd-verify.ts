import { getCachedFactCount, readApproxFactsRowCount, resetVerifyFactCountCacheForTests } from "./verify/fact-count.js";
import { computeVectorSqliteOrphans } from "./verify/orphans.js";

export { computeVectorSqliteOrphans, getCachedFactCount, readApproxFactsRowCount, resetVerifyFactCountCacheForTests };
import { createVerifyRunState, type VerifyRunOpts } from "./verify/verify-run-state.js";
import { runVerifyInfrastructureSection } from "./verify/sections/infrastructure.js";
import { runVerifyEmbeddingsSection } from "./verify/sections/embeddings.js";
import { runVerifyLlmModelsSection } from "./verify/sections/llm-models.js";
import { runVerifyConfigCronSection } from "./verify/sections/config-cron.js";
import { runVerifyReconcileSection } from "./verify/sections/reconcile.js";
import { runVerifyStorageSyncSection } from "./verify/sections/storage-sync.js";
import { runVerifyUiIntegrationsSection } from "./verify/sections/ui-integrations.js";

export async function runVerifyForCli(
  ctx: import("./handlers.js").HandlerContext,
  opts: VerifyRunOpts,
  sink: import("./types.js").VerifyCliSink,
): Promise<void> {
  const state = createVerifyRunState(ctx, opts, sink);
  await runVerifyInfrastructureSection(state);
  await runVerifyEmbeddingsSection(state);
  await runVerifyLlmModelsSection(state);
  await runVerifyConfigCronSection(state);
  await runVerifyUiIntegrationsSection(state);
  await runVerifyReconcileSection(state);
  await runVerifyStorageSyncSection(state);

  // Centralized, single point of truth for the exit code: runVerifyConfigCronSection prints its
  // own summary and previously only set process.exitCode for the restartPending case, never for
  // real issues (state.allOk === false) — a CI/automation script gating on `verify`'s exit code
  // silently passed despite genuine problems. Reconcile/UiIntegrations/StorageSync run AFTER
  // ConfigCron and can also flip state.allOk to false, so this check must happen here, after
  // every section has run, not inside any single section.
  if (!state.allOk && process.exitCode == null) {
    process.exitCode = 1;
  }
}
