#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "index.ts");
const lines = readFileSync(indexPath, "utf8").split("\n");

const registerImports = `import { dirname, join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { AgentHealthStore, agentHealthDbPathForMemorySqlite } from "../backends/agent-health-store.js";
import { AuditStore, auditDbPathForMemorySqlite } from "../backends/audit-store.js";
import { EventBus } from "../backends/event-bus.js";
import { LearningsDB } from "../backends/learnings-db.js";
import type { MemoryPluginAPI } from "../api/memory-plugin-api.js";
import { type PluginRuntime, clearRuntimeTimers, createTimers } from "../api/plugin-runtime.js";
import type { MemoryCategory } from "../config.js";
import { hybridConfigSchema } from "../config/hybrid-schema.js";
import { createPendingLLMWarnings } from "../services/chat.js";
import { detectCategory as detectCategoryUtil, shouldCapture as shouldCaptureUtil } from "../services/capture-utils.js";
import { ContextualVariantGenerator, VariantGenerationQueue } from "../services/contextual-variants.js";
import { capturePluginError } from "../services/error-reporter.js";
import { PythonBridge } from "../services/python-bridge.js";
import { findSimilarByEmbedding } from "../services/vector-search.js";
import { walRemove, walWrite } from "../services/wal-helpers.js";
import {
  registerHybridMemCliHelpOnlyWithApi,
  registerHybridMemCliMetadataOnly,
  registerHybridMemCliWithApi,
} from "./cli-context.js";
import { closeOldDatabases, initializeDatabases } from "./init-databases.js";
import { createPluginService } from "./plugin-service.js";
import {
  applyGatewayEmbeddingInheritanceBeforeParse,
  shallowClonePluginConfigForGatewayMerge,
} from "./provider-router.js";
import { registerLifecycleHooks } from "./register-hooks.js";
import { registerTools } from "./register-tools.js";
import { PLUGIN_ID } from "../utils/constants.js";
import { isHybridMemHelpInvocation } from "../index-help.js";
import { isHybridMemJsonInvocation, wrapApiLoggerStderrForJsonCli } from "../utils/hybrid-mem-json-cli.js";
import {
  getCategoryDecisionRegex,
  getCategoryEntityRegex,
  getCategoryFactRegex,
  getCategoryPreferenceRegex,
  getMemoryTriggers,
} from "../utils/language-keywords.js";
import { initPluginLogger } from "../utils/logger.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";
import { versionInfo } from "../versionInfo.js";
`;

const body = lines.slice(345, 875).join("\n"); // runtimeRef through end of runMemoryHybridRegister

writeFileSync(
  join(root, "index-help.ts"),
  `${lines.slice(876, 886).join("\n")}
`,
);

writeFileSync(
  join(root, "setup/register-plugin.ts"),
  `${registerImports}

${body}

export { runtimeRef, shouldCapture, detectCategory, performHybridMemCliTeardown, runMemoryHybridRegister };
`,
);

const newIndex =
  lines.slice(0, 314).join("\n") +
  `
import {
  detectCategory,
  performHybridMemCliTeardown,
  runMemoryHybridRegister,
  runtimeRef,
  shouldCapture,
} from "./setup/register-plugin.js";
export { isHybridMemHelpInvocation } from "./index-help.js";

` +
  lines.slice(408, 875).join("\n") +
  lines.slice(876).join("\n");

// Fix index: remove duplicate memoryHybridPlugin block - we need surgical edit
console.log("Wrote setup/register-plugin.ts and index-help.ts — patch index.ts manually");
