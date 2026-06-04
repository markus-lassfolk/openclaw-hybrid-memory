import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setKeywordsPath, getDirectiveSignalRegex } from "../../utils/language-keywords.js";
import { runDirectiveExtract } from "../../services/directive-extract.js";
import { getSessionFilePathsSince } from "../../cli/cmd-extract-sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const workHome = join(here, "../../.offline-qa/sandbox-work");
setKeywordsPath(join(workHome, ".openclaw/memory"));

const days = Number.parseInt(process.argv[2] ?? "7", 10);
const agentArg = process.argv[3] ?? "main";
const agentsRoot = join(workHome, ".openclaw/agents");
const agents = agentArg === "all" ? readdirSync(agentsRoot) : [agentArg];

let totalSessions = 0;
let totalIncidents = 0;
let totalRejected = 0;
const byAgent: Record<string, { sessions: number; incidents: number; rejected: number }> = {};

for (const agent of agents) {
  const sessionDir = join(agentsRoot, agent, "sessions");
  const paths = getSessionFilePathsSince(sessionDir, days);
  if (paths.length === 0) continue;
  const r = runDirectiveExtract({
    filePaths: paths,
    directiveRegex: getDirectiveSignalRegex(),
  });
  byAgent[agent] = { sessions: paths.length, incidents: r.incidents.length, rejected: r.rejected ?? 0 };
  totalSessions += paths.length;
  totalIncidents += r.incidents.length;
  totalRejected += r.rejected ?? 0;
}

console.log(JSON.stringify({ days, totalSessions, totalIncidents, totalRejected, byAgent }, null, 2));
