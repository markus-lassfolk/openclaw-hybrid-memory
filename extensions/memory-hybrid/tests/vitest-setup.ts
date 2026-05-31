import { afterEach, beforeEach } from "vitest";
import { resetPluginRegistrationStateForTests } from "../setup/register-plugin.js";

beforeEach(() => {
  // Re-register in vitest cannot rely on sync Atomics.wait to pump teardown timers.
  process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY = "reuse-databases";
});

afterEach(() => {
  resetPluginRegistrationStateForTests();
});
