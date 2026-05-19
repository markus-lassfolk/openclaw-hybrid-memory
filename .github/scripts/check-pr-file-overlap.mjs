#!/usr/bin/env node
/**
 * Fail when more than maxOpen PRs touch the same path under extensions/memory-hybrid/.
 * Usage: node .github/scripts/check-pr-file-overlap.mjs [--max-open 2] [--max-open=2]
 */
import { execSync } from "node:child_process";

function parseMaxOpenArg() {
  const eq = process.argv.find((a) => a.startsWith("--max-open="));
  if (eq) return eq.split("=")[1];
  const idx = process.argv.indexOf("--max-open");
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("-")) {
    return process.argv[idx + 1];
  }
  return process.env.PR_OVERLAP_MAX ?? "2";
}

const maxOpen = Number.parseInt(parseMaxOpenArg(), 10);

const prefix = "extensions/memory-hybrid/";
const currentPr = process.env.GITHUB_PR_NUMBER
  ? Number.parseInt(process.env.GITHUB_PR_NUMBER, 10)
  : null;

function ghJson(args) {
  return JSON.parse(execSync(`gh ${args.join(" ")}`, { encoding: "utf8" }));
}

const prs = ghJson(["pr", "list", "--state", "open", "--json", "number,files,title"]);
const byFile = new Map();
/** Paths touched by the PR under review (when GITHUB_PR_NUMBER is set). */
const currentPrPaths = new Set();

for (const pr of prs) {
  for (const f of pr.files ?? []) {
    if (!f.path.startsWith(prefix)) continue;
    if (currentPr != null && pr.number === currentPr) {
      currentPrPaths.add(f.path);
      continue;
    }
    if (!byFile.has(f.path)) byFile.set(f.path, []);
    byFile.get(f.path).push({ number: pr.number, title: pr.title });
  }
}

const pathsToCheck =
  currentPr != null && currentPrPaths.size > 0
    ? [...currentPrPaths]
    : [...byFile.keys()];

// When the current PR is excluded from byFile, list.length counts only *other* PRs;
// use >= so current + maxOpen others (maxOpen+1 total) still triggers a violation.
const exceedsMaxOpen = ([, list]) =>
  currentPr != null && currentPrPaths.size > 0 ? list.length >= maxOpen : list.length > maxOpen;

const violations = pathsToCheck
  .map((path) => [path, byFile.get(path) ?? []])
  .filter(exceedsMaxOpen)
  .sort((a, b) => b[1].length - a[1].length);

if (violations.length === 0) {
  const limitDesc =
    currentPr != null && currentPrPaths.size > 0
      ? `${maxOpen} other open PR(s) plus this PR`
      : `more than ${maxOpen} open PRs`;
  console.log(`OK: no path has ${limitDesc} under ${prefix}`);
  process.exit(0);
}

console.error(`Found ${violations.length} path(s) with more than ${maxOpen} open PRs:\n`);
for (const [path, list] of violations) {
  console.error(`  ${path} (${list.length} PRs)`);
  for (const { number, title } of list) {
    console.error(`    #${number} ${title}`);
  }
  console.error("");
}
process.exit(1);
