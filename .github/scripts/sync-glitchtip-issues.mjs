#!/usr/bin/env node
/**
 * Mirror unresolved GlitchTip issues into GitHub issues, deduped by GlitchTip issue ID.
 *
 * This repo is public, so the body is built from an explicit field allowlist rather than
 * dumping the raw GlitchTip event — see ALLOWED_TAG_KEYS / DENY_KEY_PATTERN below. Breadcrumbs,
 * user/request/extra contexts, and the GlitchTip host itself are never included.
 *
 * Env: GLITCHTIP_TOKEN, GLITCHTIP_BASE_URL, ORG_SLUG, PROJECT_SLUG, QUERY, DRY_RUN ("true"/"false"),
 *      GITHUB_REPOSITORY (owner/repo, provided by Actions).
 */
import { execFileSync } from "node:child_process";

const GLITCHTIP_TOKEN = requireEnv("GLITCHTIP_TOKEN");
const GLITCHTIP_BASE_URL = requireEnv("GLITCHTIP_BASE_URL");
const ORG_SLUG = process.env.ORG_SLUG || "hybrid-memory";
const PROJECT_SLUG = process.env.PROJECT_SLUG || "openclaw-hybrid-memory";
const QUERY = process.env.QUERY || "is:unresolved";
const DRY_RUN = (process.env.DRY_RUN ?? "true") !== "false";
const SYNC_LABEL = "glitchtip-sync";

const ALLOWED_TAG_KEYS = new Set([
  "job_name",
  "step_name",
  "operation",
  "subsystem",
  "component",
  "failure_class",
  "failure_category",
  "semantic_status",
  "phase",
  "release",
  "exit_code",
  "environment",
]);

const DENY_KEY_PATTERN = /user|email|ip|token|key|secret|credential|password|session|bot_name|agent_name/i;

// Collapses long filesystem-looking paths (container mounts, cargo registry paths, etc.) down to
// their final component. Best-effort text scrubbing over free-form error messages/titles — not a
// guarantee that no sensitive substring ever survives, hence dry_run defaults to true.
function redactPaths(text) {
  if (!text) return text;
  return text.replace(/(?:\.{1,2}\/|\/)?(?:[\w.\-]+\/){2,}[\w.\-]+/g, (match) => {
    const parts = match.split("/").filter(Boolean);
    return `.../${parts.slice(-2).join("/")}`;
  });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`::error::Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

async function glitchtipGet(path, params) {
  const url = new URL(`${GLITCHTIP_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${GLITCHTIP_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`GlitchTip API ${url.pathname} returned HTTP ${res.status}`);
  }
  return res.json();
}

function gh(args, input) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    env: process.env,
  });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function buildBody(issue, event) {
  const tags = Object.fromEntries((event.tags ?? []).map((t) => [t.key, t.value]));
  const maintenance = event.contexts?.maintenance ?? {};

  const safeTagLines = Object.entries(tags)
    .filter(([key]) => ALLOWED_TAG_KEYS.has(key) && !DENY_KEY_PATTERN.test(key))
    .map(([key, value]) => `- \`${key}\`: ${redactPaths(String(value))}`);

  for (const key of ["failure_class", "failure_category", "guard_state_after"]) {
    if (maintenance[key] && !safeTagLines.some((l) => l.includes(`\`${key}\``))) {
      safeTagLines.push(`- \`${key}\`: ${redactPaths(String(maintenance[key]))}`);
    }
  }

  const exceptionValues = event.entries?.find((e) => e.type === "exception")?.data?.values ?? [];
  const frameLines = exceptionValues
    .flatMap((v) => v.stacktrace?.frames ?? [])
    .filter((f) => f.inApp)
    .map((f) => `${f.filename}:${f.lineNo}:${f.colNo} (${f.function})`);

  const message = redactPaths(issue.metadata?.value ?? issue.title ?? "");

  const lines = [
    `<!-- ${SYNC_LABEL} -->`,
    `<!-- glitchtip-id: ${issue.id} -->`,
    `<!-- glitchtip-org: ${ORG_SLUG} -->`,
    `<!-- glitchtip-project: ${PROJECT_SLUG} -->`,
    "",
    `**Source:** GlitchTip issue \`#${issue.id}\` (org \`${ORG_SLUG}\` / project \`${PROJECT_SLUG}\`)`,
    `**Type:** ${issue.metadata?.type ?? issue.type ?? "unknown"}`,
    `**Level:** ${issue.level}`,
    `**First seen:** ${issue.firstSeen}`,
    `**Last seen:** ${issue.lastSeen}`,
    `**Event count:** ${issue.count}`,
    "",
    "### Message",
    "",
    `> ${message}`,
    "",
  ];

  if (safeTagLines.length > 0) {
    lines.push("### Tags", "", ...safeTagLines, "");
  }

  if (frameLines.length > 0) {
    lines.push("### Stack trace (in-app frames only)", "", "```", ...frameLines, "```", "");
  }

  lines.push(
    "---",
    "_Auto-synced from GlitchTip error tracking. Fields are allowlisted and best-effort " +
      "redacted for a public repository — breadcrumbs, user/request context, and the GlitchTip " +
      "host are never included, and filesystem paths are collapsed. Free-text message content " +
      "above is not guaranteed to be fully scrubbed; edit this issue if you spot anything that " +
      "shouldn't be public._",
  );

  return lines.join("\n");
}

function buildTitle(issue) {
  const raw = issue.title || issue.metadata?.value || `GlitchTip issue #${issue.id}`;
  const redacted = redactPaths(raw);
  const truncated = redacted.length > 120 ? `${redacted.slice(0, 117)}...` : redacted;
  return `[GlitchTip #${issue.id}] ${truncated}`;
}

async function main() {
  const issues = await glitchtipGet(`/api/0/projects/${ORG_SLUG}/${PROJECT_SLUG}/issues/`, {
    query: QUERY,
    limit: "100",
  });
  console.log(`Fetched ${issues.length} GlitchTip issue(s) matching "${QUERY}"`);

  const existing = ghJson([
    "issue",
    "list",
    "--repo",
    process.env.GITHUB_REPOSITORY,
    "--label",
    SYNC_LABEL,
    "--state",
    "all",
    "--json",
    "number,body",
    "--limit",
    "200",
  ]);
  const syncedIds = new Set(
    existing
      .map((i) => /<!-- glitchtip-id: (\d+) -->/.exec(i.body ?? "")?.[1])
      .filter(Boolean),
  );
  console.log(`Found ${syncedIds.size} already-synced GlitchTip issue(s) in GitHub`);

  if (!DRY_RUN) {
    gh([
      "label",
      "create",
      SYNC_LABEL,
      "--repo",
      process.env.GITHUB_REPOSITORY,
      "--color",
      "5319e7",
      "--description",
      "Auto-synced from GlitchTip error tracking",
      "--force",
    ]);
  }

  const summaryLines = [`## GlitchTip → GitHub issue sync${DRY_RUN ? " (dry run)" : ""}`, ""];
  let created = 0;
  let skipped = 0;

  for (const issue of issues) {
    if (syncedIds.has(String(issue.id))) {
      skipped++;
      summaryLines.push(`- skip: GlitchTip #${issue.id} already synced`);
      continue;
    }

    const event = await glitchtipGet(`/api/0/issues/${issue.id}/events/latest/`);
    const title = buildTitle(issue);
    const body = buildBody(issue, event);

    if (DRY_RUN) {
      summaryLines.push(`- would create: **${title}**`, "", "<details><summary>preview body</summary>", "", body, "", "</details>", "");
      created++;
      continue;
    }

    const url = gh([
      "issue",
      "create",
      "--repo",
      process.env.GITHUB_REPOSITORY,
      "--title",
      title,
      "--body",
      body,
      "--label",
      SYNC_LABEL,
    ]).trim();
    summaryLines.push(`- created: ${url}`);
    created++;
  }

  summaryLines.push("", `**${created} ${DRY_RUN ? "would be created" : "created"}, ${skipped} already synced (skipped).**`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(summaryPath, `${summaryLines.join("\n")}\n`);
  }
  console.log(summaryLines.join("\n"));
}

main().catch((err) => {
  console.error(`::error::${err.stack ?? err.message}`);
  process.exit(1);
});
