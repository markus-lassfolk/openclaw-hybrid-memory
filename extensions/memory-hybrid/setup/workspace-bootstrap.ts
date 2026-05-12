import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type BootstrapEntryResult = {
  path: string;
  created: boolean;
  kind: "directory" | "file";
};

export type WorkspaceBootstrapResult = {
  workspaceRoot: string;
  directories: BootstrapEntryResult[];
  files: BootstrapEntryResult[];
};

const WORKSPACE_DIRECTORIES = [
  "memory",
  "memory/people",
  "memory/projects",
  "memory/technical",
  "memory/companies",
  "memory/decisions",
  "memory/archive",
] as const;

const WORKSPACE_FILE_TEMPLATES: ReadonlyArray<{ relativePath: string; body: string }> = [
  {
    relativePath: "AGENTS.md",
    body: "# AGENTS\n\n## How to use hybrid memory in this workspace\n\n- Store durable facts, preferences, and decisions with hybrid-memory tools.\n- Keep project-specific instructions in this workspace when they should survive across sessions.\n- Review MEMORY.md and TOOLS.md before adding new long-lived conventions.\n",
  },
  {
    relativePath: "SOUL.md",
    body: "# SOUL\n\nDescribe the agent's long-lived identity, tone, and non-task-specific values here.\n",
  },
  {
    relativePath: "USER.md",
    body: "# USER\n\nCapture stable user preferences, boundaries, and collaboration habits here.\n",
  },
  {
    relativePath: "MEMORY.md",
    body: "# MEMORY\n\nUse this file as the human-readable landing page for your workspace memory.\n\n- Put high-signal summaries here.\n- Store detailed durable facts under memory/.\n- Use openclaw hybrid-mem status for a quick operational summary.\n",
  },
  {
    relativePath: "HEARTBEAT.md",
    body: "# HEARTBEAT\n\nTrack recurring review/check-in routines that should happen every session or every day.\n",
  },
  {
    relativePath: "IDENTITY.md",
    body: "# IDENTITY\n\nDocument operator-approved identity, role, and boundaries for this workspace.\n",
  },
];

function ensureDirectory(path: string, dryRun: boolean): BootstrapEntryResult {
  let created = !existsSync(path);
  if (!dryRun) {
    const createdPath = mkdirSync(path, { recursive: true });
    created = typeof createdPath === "string";
  }
  return { path, created, kind: "directory" };
}

function ensureFile(path: string, body: string, dryRun: boolean): BootstrapEntryResult {
  const created = !existsSync(path);
  if (created && !dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf-8");
  }
  return { path, created, kind: "file" };
}

export function ensureWorkspaceBootstrap(opts: { workspaceRoot: string; dryRun: boolean }): WorkspaceBootstrapResult {
  const directories = WORKSPACE_DIRECTORIES.map((relativePath) =>
    ensureDirectory(join(opts.workspaceRoot, relativePath), opts.dryRun),
  );
  const files = WORKSPACE_FILE_TEMPLATES.map((template) =>
    ensureFile(join(opts.workspaceRoot, template.relativePath), template.body, opts.dryRun),
  );
  return {
    workspaceRoot: opts.workspaceRoot,
    directories,
    files,
  };
}
