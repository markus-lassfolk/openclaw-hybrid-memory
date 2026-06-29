/** Upgrade subcommand that skips full plugin bootstrap (issue #2000). */
export function isHybridMemUpgradeOnlyInvocation(argv: string[]): boolean {
  const hybridIdx = argv.indexOf("hybrid-mem");
  if (hybridIdx === -1) return false;
  for (let i = hybridIdx + 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (a === "upgrade") return true;
  }
  return false;
}
