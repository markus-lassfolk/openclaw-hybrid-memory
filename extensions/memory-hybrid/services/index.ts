export { installCoreBootstrapServices } from "./bootstrap.js";
export { installOptionalBootstrapServices } from "./bootstrap-optional.js";

import { optionalBootstrapInstaller } from "./bootstrap-optional.js";
import { orderByBootstrapPhase } from "./bootstrap-priority.js";
import { coreBootstrapInstaller } from "./bootstrap.js";

/** Ordered bootstrap manifest for startup audits and tests. */
export const bootstrapInstallers = orderByBootstrapPhase([coreBootstrapInstaller, optionalBootstrapInstaller]);
