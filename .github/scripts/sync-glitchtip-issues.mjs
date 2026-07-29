#!/usr/bin/env node
/**
 * Bidirectional sync between GlitchTip issues and GitHub issues:
 *
 *   1. GlitchTip -> GitHub: mirror unresolved GlitchTip issues into GitHub issues, deduped by
 *      GlitchTip issue ID.
 *   2. GitHub -> GlitchTip: for previously-synced GitHub issues that have been closed, push the
 *      resolution back onto the GlitchTip issue (`completed` -> resolved; `not_planned` or
 *      `duplicate` -> ignored). Issues still open on GitHub are left alone on the GlitchTip side.
 *
 * This repo is public, so the GitHub issue body is built from an explicit field allowlist rather
 * than dumping the raw GlitchTip event — see ALLOWED_TAG_KEYS / DENY_KEY_PATTERN below.
 * Breadcrumbs, user/request/extra contexts, and the GlitchTip host itself are never included.
 *
 * Env: GLITCHTIP_TOKEN, GLITCHTIP_BASE_URL, ORG_SLUG, PROJECT_SLUG, QUERY, DRY_RUN ("true"/"false"),
 *      GITHUB_REPOSITORY (owner/repo, provided by Actions).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const GLITCHTIP_TOKEN = requireEnv("GLITCHTIP_TOKEN");
const GLITCHTIP_BASE_URL = requireEnv("GLITCHTIP_BASE_URL");
const ORG_SLUG = process.env.ORG_SLUG || "hybrid-memory";
const PROJECT_SLUG = process.env.PROJECT_SLUG || "openclaw-hybrid-memory";
const QUERY = process.env.QUERY || "is:unresolved";
const DRY_RUN = (process.env.DRY_RUN ?? "true") !== "false";
const SYNC_LABEL = "glitchtip-sync";

// "Resolved in release <tag>" instead of a bare "resolved" lets GlitchTip's own regression
// detection do the version-awareness for us: a later event tagged with this release (or newer)
// flips the issue back to unresolved as a genuine regression, while an event from an older
// release (a client that hasn't upgraded yet) does not — see the release tag format already
// emitted by capturePluginError(), e.g. "openclaw-hybrid-memory@2026.7.226".
const PACKAGE_JSON_PATH = new URL("../../extensions/memory-hybrid/package.json", import.meta.url);
const { name: PACKAGE_NAME, version: PACKAGE_VERSION } = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
const RELEASE_TAG = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;

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

async function glitchtipSetStatus(issueId, status, statusDetails) {
  // The flat /api/0/issues/{id}/ route is read/delete only (confirmed via OPTIONS: "Allow: DELETE,
  // GET"). Status mutation lives on the org-scoped route instead ("Allow: PUT, DELETE, GET") —
  // this also matters for statusDetails specifically: Sentry's older per-issue endpoint is known to
  // silently ignore statusDetails and just resolve in the current release, while the org-scoped
  // endpoint we already use here honors it.
  const url = new URL(`${GLITCHTIP_BASE_URL}/api/0/organizations/${ORG_SLUG}/issues/${issueId}/`);
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GLITCHTIP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(statusDetails ? { status, statusDetails } : { status }),
  });
  if (!res.ok) {
    throw new Error(`GlitchTip API PUT ${url.pathname} returned HTTP ${res.status}`);
  }
  return res.json();
}

// Only closed GitHub issues drive a GlitchTip status change; open issues are left alone so that
// manual triage done directly in GlitchTip (snoozing, etc.) isn't clobbered every run.
const IGNORED_CLOSE_REASONS = new Set(["not_planned", "duplicate"]);

function resolveTargetGlitchTipStatus(ghIssue) {
  if ((ghIssue.state ?? "").toLowerCase() !== "closed") return null;
  const reason = (ghIssue.stateReason ?? "").toLowerCase();
  // "not_planned" (won't fix) and "duplicate" (tracked elsewhere, not separately fixed) both mean
  // the underlying error isn't confirmed fixed, so they map to "ignored" rather than "resolved".
  return IGNORED_CLOSE_REASONS.has(reason) ? "ignored" : "resolved";
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
    "number,body,state,stateReason",
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

  summaryLines.push("", `## GlitchTip status sync (GitHub → GlitchTip)${DRY_RUN ? " (dry run)" : ""}`, "");
  let statusUpdated = 0;
  let statusSkipped = 0;

  for (const ghIssue of existing) {
    const glitchtipId = /<!-- glitchtip-id: (\d+) -->/.exec(ghIssue.body ?? "")?.[1];
    if (!glitchtipId) continue;

    const targetStatus = resolveTargetGlitchTipStatus(ghIssue);
    if (!targetStatus) continue; // still open on GitHub — leave GlitchTip status alone
    // Only "resolved" has a meaningful fix version; "ignored" (won't-fix/duplicate) has no
    // release to be regression-checked against.
    const statusDetails = targetStatus === "resolved" ? { inRelease: RELEASE_TAG } : undefined;

    const current = await glitchtipGet(`/api/0/issues/${glitchtipId}/`);
    if (current.status === targetStatus) {
      statusSkipped++;
      continue;
    }

    if (DRY_RUN) {
      summaryLines.push(
        `- would set GlitchTip #${glitchtipId} \`${current.status}\` → \`${targetStatus}\`` +
          `${statusDetails ? ` (inRelease: \`${statusDetails.inRelease}\`)` : ""} ` +
          `(GitHub #${ghIssue.number} closed as ${ghIssue.stateReason ?? "completed"})`,
      );
      statusUpdated++;
      continue;
    }

    await glitchtipSetStatus(glitchtipId, targetStatus, statusDetails);
    summaryLines.push(
      `- set GlitchTip #${glitchtipId} \`${current.status}\` → \`${targetStatus}\` (GitHub #${ghIssue.number})`,
    );
    statusUpdated++;
  }

  summaryLines.push(
    "",
    `**${statusUpdated} ${DRY_RUN ? "would be updated" : "updated"}, ${statusSkipped} already in sync.**`,
  );

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
