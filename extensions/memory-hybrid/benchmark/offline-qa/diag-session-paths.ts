import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseConfig } from "../../config/parsers/index.js";
import { resolveExtractSessionFilePaths } from "../../services/extract-session-paths.js";

const here = dirname(fileURLToPath(import.meta.url));
const workHome = join(here, "../../.offline-qa/sandbox-work");
process.env.HOME = workHome;
const oc = JSON.parse(readFileSync(join(workHome, ".openclaw/openclaw.json"), "utf8"));
const mem = oc.plugins.entries["openclaw-hybrid-memory"].config;
const cfg = parseConfig(mem);
console.log("HOME", process.env.HOME);
console.log("homedir()", homedir());
console.log("allAgentSessions", cfg.procedures.allAgentSessions);
console.log("paths7d", resolveExtractSessionFilePaths(cfg, 7).length);
