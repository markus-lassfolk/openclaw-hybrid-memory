#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "cli/commands/manage/register-storage-and-stats.ts");
const lines = readFileSync(path, "utf8").split("\n");
const imports = lines.slice(0, 42).join("\n");
const helpers = lines.slice(43, 946).join("\n");
const maintenanceBody = lines.slice(965, 1925).join("\n");
const entitiesBody = lines.slice(1925, 2327).join("\n");
const graphBody = lines.slice(2327, 3238).join("\n");

const destructure = `  const {
    factsDb,
    vectorDb,
    aliasDb,
    versionInfo,
    embeddings,
    mergeResults: merge,
    getMemoryCategories,
    cfg,
    runCompaction,
    tieringEnabled,
    ctx,
    listCommands,
    auditStore,
    runExport,
  } = b;
`;

const header = (name) => `${imports}

export function ${name}(mem, b) {
${destructure}
`;

const manageDir = join(root, "cli/commands/manage");
writeFileSync(join(manageDir, "storage-stats-helpers.ts"), `${imports}\n${helpers}\n`);
writeFileSync(
  join(manageDir, "register-storage-maintenance.ts"),
  `${header("registerManageStorageMaintenance")}\n${maintenanceBody}\n}\n`,
);
writeFileSync(
  join(manageDir, "register-storage-entities-decay.ts"),
  `${header("registerManageStorageEntitiesDecay")}\n${entitiesBody}\n}\n`,
);
writeFileSync(
  join(manageDir, "register-storage-graph-audit.ts"),
  `${header("registerManageStorageGraphAudit")}\n${graphBody}\n}\n`,
);

writeFileSync(
  join(manageDir, "register-storage-and-stats.ts"),
  `${imports}
import { registerManageStorageMaintenance } from "./register-storage-maintenance.js";
import { registerManageStorageEntitiesDecay } from "./register-storage-entities-decay.js";
import { registerManageStorageGraphAudit } from "./register-storage-graph-audit.js";
export {
  IMPLICIT_FEEDBACK_HISTOGRAM_SAMPLE_CAP,
  recordStorageGrowthSample,
  buildAuditHealthReport,
} from "./storage-stats-helpers.js";

export function registerManageStorageAndStats(mem, b) {
  registerManageStorageMaintenance(mem, b);
  registerManageStorageEntitiesDecay(mem, b);
  registerManageStorageGraphAudit(mem, b);
}
`,
);

console.log("storage split ok");
