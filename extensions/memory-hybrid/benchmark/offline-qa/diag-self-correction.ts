import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gatherSessionFiles } from "../../cli/cmd-distill.js";
import { getCorrectionSignalRegex, setKeywordsPath } from "../../utils/language-keywords.js";
import { runSelfCorrectionExtract } from "../../services/self-correction-extract.js";

const here = dirname(fileURLToPath(import.meta.url));
const workHome = join(here, "../../.offline-qa/sandbox-work");
process.env.HOME = workHome;
setKeywordsPath(join(workHome, ".openclaw/memory"));

const days = Number.parseInt(process.argv[2] ?? "7", 10);
const files = gatherSessionFiles({ days }).map((f) => f.path);
const r = runSelfCorrectionExtract({ filePaths: files, correctionRegex: getCorrectionSignalRegex() });
console.log(JSON.stringify({ days, sessions: files.length, incidents: r.incidents.length }, null, 2));
