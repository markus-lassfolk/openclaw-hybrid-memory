import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { hybridConfigSchema, type HybridMemoryConfig } from "../config.js";
import {
  applyGatewayEmbeddingInheritanceBeforeParse,
  shallowClonePluginConfigForGatewayMerge,
} from "./provider-router.js";

/** Parse effective hybrid-mem plugin config from the OpenClaw API (shared by full + fast-path register). */
export function parseHybridMemPluginConfig(api: ClawdbotPluginApi): HybridMemoryConfig {
  const rawPc = api.pluginConfig;
  const buildConfigToParse = (): unknown => {
    if (rawPc && typeof rawPc === "object" && !Array.isArray(rawPc)) {
      const clone = shallowClonePluginConfigForGatewayMerge(rawPc as Record<string, unknown>);
      applyGatewayEmbeddingInheritanceBeforeParse(clone, api);
      return clone;
    }
    return rawPc;
  };
  return hybridConfigSchema.parse(buildConfigToParse());
}
