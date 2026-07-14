/**
 * hybrid-mem version reporting — shared by `hybrid-mem version` and root `--version` (issue #2012).
 */

export const HYBRID_MEM_PACKAGE_NAME = "openclaw-hybrid-memory";
export const HYBRID_MEM_UPGRADE_COMMAND = "openclaw hybrid-mem upgrade";

const GITHUB_LATEST_URL = "https://api.github.com/repos/markus-lassfolk/openclaw-hybrid-memory/releases/latest";
const NPM_LATEST_URL = "https://registry.npmjs.org/openclaw-hybrid-memory/latest";
const DEFAULT_FETCH_TIMEOUT_MS = 3000;

export type VersionReport = {
  name: string;
  installed: string;
  github: string | null;
  npm: string | null;
  updateAvailable: boolean;
};

export function comparePluginVersions(a: string, b: string): number {
  const parseNum = (s: string): number => {
    const n = Number.parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  };
  const pa = a
    .replace(/[-+].*/, "")
    .split(".")
    .map(parseNum);
  const pb = b
    .replace(/[-+].*/, "")
    .split(".")
    .map(parseNum);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

export async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return res;
  } catch (err) {
    clearTimeout(t);
    if (err instanceof Error && err.name === "AbortError") throw new Error("Request timed out");
    throw err;
  }
}

export async function fetchLatestPluginVersions(
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<{ github: string | null; npm: string | null }> {
  let github: string | null = null;
  let npm: string | null = null;

  try {
    const ghRes = await fetchWithTimeout(GITHUB_LATEST_URL, timeoutMs);
    if (ghRes.ok) {
      const data = (await ghRes.json()) as { tag_name?: string };
      const tag = data.tag_name;
      github = typeof tag === "string" ? tag.replace(/^v/, "") : null;
    }
  } catch {
    github = null;
  }

  try {
    const npmRes = await fetchWithTimeout(NPM_LATEST_URL, timeoutMs);
    if (npmRes.ok) {
      const data = (await npmRes.json()) as { version?: string };
      npm = typeof data.version === "string" ? data.version : null;
    }
  } catch {
    npm = null;
  }

  return { github, npm };
}

export function buildVersionReport(installed: string, github: string | null, npm: string | null): VersionReport {
  return {
    name: HYBRID_MEM_PACKAGE_NAME,
    installed,
    github,
    npm,
    updateAvailable:
      (github != null && comparePluginVersions(installed, github) < 0) ||
      (npm != null && comparePluginVersions(installed, npm) < 0),
  };
}

function updateHint(installed: string, latest: string | null): string {
  if (latest == null) return "";
  return comparePluginVersions(installed, latest) < 0 ? " ⬆ update available" : " (up to date)";
}

function versionJsonPayload(report: VersionReport): Record<string, unknown> {
  return {
    name: report.name,
    installed: report.installed,
    github: report.github ?? "unavailable",
    npm: report.npm ?? "unavailable",
    updateAvailable: report.updateAvailable,
  };
}

/** Concise output for root `--version` (issue #2012). */
export function printVersionFlag(report: VersionReport, opts?: { json?: boolean }): void {
  if (opts?.json) {
    console.log(JSON.stringify(versionJsonPayload(report), null, 2));
    return;
  }

  console.log(`${report.name} ${report.installed}`);

  const npmUpdate = report.npm != null && comparePluginVersions(report.installed, report.npm) < 0 ? report.npm : null;
  const githubUpdate =
    report.github != null && comparePluginVersions(report.installed, report.github) < 0 ? report.github : null;

  if (npmUpdate != null) {
    console.log(`Update available: npm ${npmUpdate} (run: ${HYBRID_MEM_UPGRADE_COMMAND})`);
  } else if (githubUpdate != null) {
    console.log(`Update available: GitHub ${githubUpdate} (run: ${HYBRID_MEM_UPGRADE_COMMAND})`);
  }
}

/** Detailed output for `hybrid-mem version` subcommand. */
export function printVersionSubcommand(report: VersionReport, opts?: { json?: boolean }): void {
  if (opts?.json) {
    console.log(JSON.stringify(versionJsonPayload(report), null, 2));
    return;
  }

  const { installed, github, npm } = report;
  console.log(HYBRID_MEM_PACKAGE_NAME);
  console.log(`  Installed:  ${installed}`);
  console.log(
    `  GitHub:     ${github ?? "unavailable"}${
      github != null && comparePluginVersions(installed, github) > 0
        ? " (installed is newer)"
        : updateHint(installed, github)
    }`,
  );
  console.log(
    `  npm:        ${npm ?? "unavailable"}${
      npm != null && comparePluginVersions(installed, npm) > 0 ? " (installed is newer)" : updateHint(installed, npm)
    }`,
  );
}

export async function runHybridMemVersion(
  installed: string,
  opts?: { json?: boolean; format?: "flag" | "subcommand"; timeoutMs?: number },
): Promise<void> {
  const { github, npm } = await fetchLatestPluginVersions(opts?.timeoutMs);
  const report = buildVersionReport(installed, github, npm);
  if (opts?.format === "flag") {
    printVersionFlag(report, { json: opts.json });
  } else {
    printVersionSubcommand(report, { json: opts?.json });
  }
}
