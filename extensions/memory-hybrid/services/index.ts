export { BOOTSTRAP_PHASE_ORDER, compareBootstrapPhase, orderByBootstrapPhase } from "./bootstrap-priority.js";
export {
  coreBootstrapInstaller,
  installCoreBootstrapServices,
  type CoreBootstrapContext,
  type CoreBootstrapInstaller,
  type CoreBootstrapServices,
} from "./bootstrap.js";
export {
  optionalBootstrapInstaller,
  installOptionalBootstrapServices,
  type OptionalBootstrapContext,
  type OptionalBootstrapInstaller,
  type OptionalBootstrapServices,
} from "./bootstrap-optional.js";

import { optionalBootstrapInstaller } from "./bootstrap-optional.js";
import { orderByBootstrapPhase } from "./bootstrap-priority.js";
import { coreBootstrapInstaller } from "./bootstrap.js";

/** Ordered bootstrap manifest for startup audits and tests. */
export const bootstrapInstallers = orderByBootstrapPhase([coreBootstrapInstaller, optionalBootstrapInstaller]);
