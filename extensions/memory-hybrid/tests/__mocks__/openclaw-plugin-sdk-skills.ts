/** Mock for openclaw/plugin-sdk/skills — bumpSkillsSnapshotVersion no-op in tests. */

export function bumpSkillsSnapshotVersion(_args: {
  workspaceDir: string;
  reason: string;
  changedPath?: string;
}): void {
  // no-op
}
